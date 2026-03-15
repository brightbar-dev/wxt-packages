/**
 * Full payment flow E2E test — exercises the complete signup path:
 * 1. Confirm extension starts in unpaid state
 * 2. Click Buy → ExtPay plan selection → enter dev password → Stripe Checkout
 * 3. Fill Stripe test card (4242...) → complete payment
 * 4. Verify extension recognizes paid status
 *
 * Requires: EXTPAY_DEV_PASSWORD env var (ExtensionPay developer password)
 * Run: EXTPAY_DEV_PASSWORD=xxx npm run test:e2e:payment
 */

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_EXT_DIR = path.resolve(__dirname, '../../test-extension');
const EXT_OUTPUT = path.resolve(TEST_EXT_DIR, '.output/chrome-mv3');
const SCREENSHOTS = path.resolve(__dirname, 'screenshots');

const TEST_EMAIL = 'testpay@kdc.simplelogin.com';
const EXTPAY_PASSWORD = process.env.EXT_PAY_PASSWORD || process.env.EXTPAY_DEV_PASSWORD || '';

test.setTimeout(120_000);

test.beforeAll(async () => {
  if (!EXTPAY_PASSWORD) {
    console.log('EXTPAY_DEV_PASSWORD not set — skipping full payment flow test');
  }
  execSync('npm run build', { cwd: TEST_EXT_DIR, stdio: 'pipe' });
});

let context: BrowserContext;

test.beforeEach(async () => {
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_OUTPUT}`,
      `--load-extension=${EXT_OUTPUT}`,
      '--no-first-run',
      '--disable-gpu',
    ],
  });
});

test.afterEach(async () => {
  await context.close();
});

async function ss(page: Page, name: string) {
  await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`), fullPage: true });
}

async function waitForExtension(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    for (const w of context.serviceWorkers()) {
      const m = w.url().match(/chrome-extension:\/\/([a-z]+)\//);
      if (m) return m[1];
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Extension did not start');
}

async function openPopup(extId: string) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  return page;
}

test('full payment flow: free → pay → pro unlocked', async () => {
  test.skip(!EXTPAY_PASSWORD, 'EXTPAY_DEV_PASSWORD env var required');

  const extId = await waitForExtension();

  // ── Step 1: Confirm unpaid state ──
  const popup = await openPopup(extId);
  await popup.locator('#pro-feature').click();
  await expect(popup.locator('#status')).not.toHaveClass(/loading/, { timeout: 15000 });
  await ss(popup, '01-initial-locked');
  const initial = await popup.locator('#status').textContent();
  console.log('Step 1 — Initial:', initial?.slice(0, 80));
  expect(initial).toContain('LOCKED');

  // ── Step 2: Click Buy → ExtPay plan page ──
  const newPagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await popup.locator('#buy').click();
  await popup.waitForTimeout(2000);

  let extpayPage = await newPagePromise;
  if (!extpayPage || !extpayPage.url().includes('extensionpay.com')) {
    extpayPage = context.pages().find(p => p.url().includes('extensionpay.com')) || null;
  }
  expect(extpayPage).toBeTruthy();
  await extpayPage!.waitForLoadState('networkidle', { timeout: 15000 });
  await ss(extpayPage!, '02-extpay-plan-page');
  console.log('Step 2 — ExtPay URL:', extpayPage!.url());

  // ── Step 3: Select plan → enter dev password → go to Stripe ──
  const planButton = extpayPage!.locator('button:has-text("Lifetime"), button:has-text("$1")');
  await expect(planButton.first()).toBeVisible({ timeout: 5000 });
  await planButton.first().click();
  await extpayPage!.waitForLoadState('networkidle', { timeout: 10000 });
  await ss(extpayPage!, '03-password-form');

  // Fill in the ExtPay developer password
  const passwordInput = extpayPage!.locator('input[type="password"][name="password"]');
  await expect(passwordInput).toBeVisible({ timeout: 5000 });
  await passwordInput.fill(EXTPAY_PASSWORD);

  // Click "Go to test payment page"
  const goButton = extpayPage!.locator('button:has-text("Go to test payment")');
  await expect(goButton).toBeVisible({ timeout: 5000 });

  await Promise.all([
    extpayPage!.waitForURL(/stripe\.com/, { timeout: 30000 }),
    goButton.click(),
  ]);
  await extpayPage!.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await ss(extpayPage!, '04-stripe-checkout');
  console.log('Step 3 — Stripe URL:', extpayPage!.url());

  // ── Step 4: Fill Stripe Checkout form ──
  const stripePage = extpayPage!;

  // Wait for Stripe to fully render — the email field appears when ready
  const emailField = stripePage.locator('input#email, input[name="email"]');
  await expect(emailField.first()).toBeVisible({ timeout: 15000 });
  await emailField.first().fill(TEST_EMAIL);
  console.log('Step 4 — Email filled');
  await ss(stripePage, '05-after-email');

  // Card fields on Stripe Checkout are direct inputs but auto-advance doesn't
  // work reliably with Playwright. Click each field explicitly.
  const cardField = stripePage.locator('input[name="cardNumber"], input[autocomplete="cc-number"]');
  await expect(cardField.first()).toBeVisible({ timeout: 10000 });

  await cardField.first().click();
  await cardField.first().type('4242424242424242', { delay: 30 });
  console.log('Step 4 — Card number typed');
  await stripePage.waitForTimeout(500);
  await ss(stripePage, '06a-after-card-number');

  // Explicitly click and fill expiry field
  const expiryField = stripePage.locator('input[name="cardExpiry"], input[placeholder*="MM" i]');
  await expect(expiryField.first()).toBeVisible({ timeout: 5000 });
  await expiryField.first().click();
  await expiryField.first().type('1230', { delay: 30 });
  console.log('Step 4 — Expiry typed');
  await stripePage.waitForTimeout(500);
  await ss(stripePage, '06b-after-expiry');

  // Explicitly click and fill CVC field
  const cvcField = stripePage.locator('input[name="cardCvc"], input[placeholder*="CVC" i]');
  await expect(cvcField.first()).toBeVisible({ timeout: 5000 });
  await cvcField.first().click();
  await cvcField.first().type('123', { delay: 30 });
  console.log('Step 4 — CVC typed');
  await stripePage.waitForTimeout(500);
  await ss(stripePage, '07-after-card-complete');

  // Cardholder name
  const nameField = stripePage.locator('input#billingName, input[name="billingName"]');
  if (await nameField.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await nameField.first().fill('Test User');
    console.log('Step 4 — Name filled');
  }

  // ZIP code — Stripe requires for US cards
  const zipField = stripePage.locator('input[name="billingPostalCode"], input[placeholder*="ZIP" i], input[autocomplete="postal-code"]');
  if (await zipField.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await zipField.first().fill('77004');
    console.log('Step 4 — ZIP filled');
  }

  await ss(stripePage, '07-all-fields');

  // ── Step 5: Submit payment ──
  const payBtn = stripePage.locator('.SubmitButton, button:has-text("Pay"), button:has-text("Subscribe"), button[type="submit"]');
  await expect(payBtn.first()).toBeVisible({ timeout: 5000 });
  console.log('Step 5 — Pay button:', await payBtn.first().textContent());
  await payBtn.first().click();
  console.log('Step 5 — Clicked pay');

  // Wait for Stripe to process and redirect back
  await stripePage.waitForTimeout(10000);
  await ss(stripePage, '08-after-payment');
  console.log('Step 5 — Post-payment URL:', stripePage.url());

  // ── Step 6: Verify extension recognizes paid status ──
  // Give ExtPay's content script relay time to notify the background
  await stripePage.waitForTimeout(5000);

  const popup2 = await openPopup(extId);
  await popup2.locator('#pro-feature').click();
  await expect(popup2.locator('#status')).not.toHaveClass(/loading/, { timeout: 15000 });
  await ss(popup2, '09-final-status');

  const finalStatus = await popup2.locator('#status').textContent();
  console.log('Step 6 — Final:', finalStatus?.slice(0, 200));
  expect(finalStatus).toContain('UNLOCKED');

  await popup2.close();
  await popup.close();
});

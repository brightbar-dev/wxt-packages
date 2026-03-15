/**
 * Runtime helpers for ExtPay integration in popup/options/background.
 *
 * Import from '@brightbar-dev/wxt-extpay/helpers':
 *   import { createExtPay, initBackground, resolveProStatus, ... } from '@brightbar-dev/wxt-extpay/helpers';
 */

// Re-export pure functions (no browser deps — safe to test)
export {
  isTrialActive,
  trialDaysRemaining,
  resolveProStatus,
  statusLabel,
  type PaymentUser,
  type ProStatus,
  type ExtPayConfig,
} from './pro-status';

// ── ExtPay instance management ─────────────────────────────
// These require a browser extension environment at runtime

import ExtPay from 'extpay';

/**
 * Create an ExtPay instance for use in popup/options pages.
 * Each page creates its own instance — do NOT share via background messaging.
 */
export function createExtPay(extensionId: string): ReturnType<typeof ExtPay> {
  return ExtPay(extensionId);
}

/**
 * Initialize ExtPay in the background script.
 * Only calls startBackground() — popup/options should NOT use this.
 */
export function initBackground(extensionId: string): void {
  try {
    const extpay = ExtPay(extensionId);
    extpay.startBackground();
  } catch (err) {
    console.warn('ExtPay background init failed:', err);
  }
}

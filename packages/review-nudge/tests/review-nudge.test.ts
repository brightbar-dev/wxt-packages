import { beforeEach, describe, expect, it } from 'vitest';
import {
  chromeWebStoreReviewUrl,
  isEligible,
  localDay,
  mountReviewNudge,
  readState,
  recordActivation,
  reviewNudgeCss,
  settle,
  type MountOptions,
  type NudgeStorage,
} from '../src/index';

const DAY = 86_400_000;
const START = new Date(2026, 8, 1, 10, 0, 0).getTime(); // local 10:00, away from midnight

function memoryStorage(): NudgeStorage & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
  };
}

let clock = START;
let storage: ReturnType<typeof memoryStorage>;
const opts = () => ({ storage, now: () => clock });
const mountOpts = (): MountOptions => ({
  ...opts(),
  name: 'JSON Viewer Pro',
  reviewUrl: chromeWebStoreReviewUrl('iodhhjpjemdfmmfffmejfnbbjbfafoac'),
  feedbackUrl: 'https://github.com/brightbar-dev/json-viewer-pro/issues/new/choose',
});

/** `perDay` uses on each of `days` consecutive days, starting at the current clock. */
async function use(days: number, perDay: number) {
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) await recordActivation(opts());
    clock += DAY;
  }
  clock -= DAY;
}

beforeEach(() => {
  clock = START;
  storage = memoryStorage();
  document.body.innerHTML = '';
});

describe('eligibility', () => {
  it('is never eligible on install, before any counted use', async () => {
    expect(await isEligible(opts())).toBe(false);
    expect(await mountReviewNudge(document.body, mountOpts())).toBeNull();
    expect(storage.data).toEqual({});
  });

  it('needs enough uses: 7 uses over 5 days is not enough by default', async () => {
    await use(5, 1);
    await recordActivation(opts());
    await recordActivation(opts());
    clock = START + 6 * DAY;
    expect((await readState(opts()))?.activations).toBe(7);
    expect(await isEligible(opts())).toBe(false);
  });

  it('needs distinct days: many uses in one sitting never qualify', async () => {
    await use(1, 50);
    clock = START + 30 * DAY;
    expect(await isEligible(opts())).toBe(false);
  });

  it('needs age: 3 busy days in a row wait until day 5 since first use', async () => {
    await use(3, 4);
    expect(await isEligible(opts())).toBe(false);
    clock = START + 5 * DAY - 1;
    expect(await isEligible(opts())).toBe(false);
    clock = START + 5 * DAY;
    expect(await isEligible(opts())).toBe(true);
  });

  it('counts calendar days, not 24-hour windows', async () => {
    const lateNight = new Date(2026, 8, 1, 23, 50).getTime();
    clock = lateNight;
    await recordActivation(opts());
    clock = lateNight + 20 * 60_000; // 00:10 the next day
    await recordActivation(opts());
    expect((await readState(opts()))?.activeDays).toBe(2);
    expect(localDay(lateNight)).toBe('2026-09-01');
  });

  it('honours custom thresholds', async () => {
    await recordActivation(opts());
    expect(await isEligible({ ...opts(), minActivations: 1, minActiveDays: 1, minAgeDays: 0 })).toBe(true);
  });

  it('ignores a corrupt stored value rather than showing', async () => {
    storage.data.reviewNudge = { status: 'counting' };
    clock = START + 100 * DAY;
    expect(await isEligible(opts())).toBe(false);
  });
});

describe('the nudge', () => {
  async function earn() {
    await use(5, 2); // ends on day 4, one short of the default five-day age
    clock = START + 5 * DAY;
  }

  it('renders one line with a review link, a separate feedback link and a dismiss', async () => {
    await earn();
    const el = await mountReviewNudge(document.body, mountOpts());
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('note');
    const links = [...el!.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://chromewebstore.google.com/detail/iodhhjpjemdfmmfffmejfnbbjbfafoac/reviews',
      'https://github.com/brightbar-dev/json-viewer-pro/issues/new/choose',
    ]);
    for (const a of links) {
      expect(a.target).toBe('_blank');
      expect(a.rel).toContain('noopener');
    }
    expect(el!.textContent).toContain('Is JSON Viewer Pro useful to you?');
    expect(el!.querySelector('button')!.textContent).toBe('Don’t ask again');
  });

  it('is shown once: it retires as it renders, even if the user does nothing', async () => {
    await earn();
    expect(await mountReviewNudge(document.body, mountOpts())).not.toBeNull();
    expect((await readState(opts()))?.status).toBe('shown');
    document.body.innerHTML = '';
    expect(await mountReviewNudge(document.body, mountOpts())).toBeNull();
    expect(document.querySelector('.bb-review-nudge')).toBeNull();
  });

  it('"Don\'t ask again" is final: no amount of later use re-arms it', async () => {
    await earn();
    const el = await mountReviewNudge(document.body, mountOpts());
    el!.querySelector('button')!.click();
    await Promise.resolve();
    expect(document.querySelector('.bb-review-nudge')).toBeNull();
    await use(60, 5);
    clock += 400 * DAY;
    const s = await readState(opts());
    expect(s?.status).toBe('dismissed');
    expect(s?.activations).toBe(10); // counting stopped when it left the counting state
    expect(await mountReviewNudge(document.body, mountOpts())).toBeNull();
  });

  it('records which link was followed and removes itself', async () => {
    await earn();
    const el = await mountReviewNudge(document.body, mountOpts());
    const feedback = el!.querySelectorAll('a')[1];
    feedback.addEventListener('click', (e) => e.preventDefault()); // keep happy-dom from navigating
    feedback.click();
    await new Promise((r) => setTimeout(r, 0));
    expect((await readState(opts()))?.status).toBe('feedback');
    expect(document.querySelector('.bb-review-nudge')).toBeNull();
  });

  it('keeps the first shownAt when the outcome is recorded', async () => {
    await earn();
    await mountReviewNudge(document.body, mountOpts());
    const shownAt = (await readState(opts()))?.shownAt;
    clock += DAY;
    await settle('reviewed', opts());
    expect((await readState(opts()))?.shownAt).toBe(shownAt);
  });

  it('takes translated strings and never parses them as HTML', async () => {
    await earn();
    const el = await mountReviewNudge(document.body, {
      ...mountOpts(),
      strings: { prompt: (n) => `<b>${n}</b> vous aide ?`, review: 'Laisser un avis' },
    });
    expect(el!.querySelector('b')).toBeNull();
    expect(el!.textContent).toContain('<b>JSON Viewer Pro</b> vous aide ?');
    expect(el!.querySelector('a')!.textContent).toBe('Laisser un avis');
  });
});

describe('storage', () => {
  it('uses chrome.storage.local when no storage is passed', async () => {
    const local = memoryStorage();
    (globalThis as { chrome?: unknown }).chrome = { storage: { local } };
    try {
      await recordActivation({ now: () => clock });
      expect((local.data.reviewNudge as { activations: number }).activations).toBe(1);
    } finally {
      delete (globalThis as { chrome?: unknown }).chrome;
    }
  });

  it('fails loudly with no storage at all', async () => {
    await expect(recordActivation()).rejects.toThrow(/no storage\.local/);
  });
});

describe('reviewNudgeCss', () => {
  it('never dims text: host muted colours at reduced opacity fall below 4.5:1', () => {
    expect(reviewNudgeCss).not.toMatch(/opacity\s*:\s*(0?\.\d+|0)\b/);
  });
});

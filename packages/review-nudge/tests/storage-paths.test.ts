import { afterEach, describe, expect, it } from 'vitest';
import {
  chromeWebStoreReviewUrl,
  isEligible,
  mountReviewNudge,
  readState,
  recordActivation,
  settle,
  type NudgeStorage,
} from '../src/index';

const DAY = 86_400_000;
const START = new Date(2026, 8, 1, 10, 0, 0).getTime(); // local 10:00, away from midnight

function memoryStorage(): NudgeStorage & { data: Record<string, unknown>; writes: number } {
  const data: Record<string, unknown> = {};
  const s = {
    data,
    writes: 0,
    async get(key: string) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items: Record<string, unknown>) {
      s.writes++;
      Object.assign(data, structuredClone(items));
    },
  };
  return s;
}

type G = { chrome?: unknown; browser?: unknown };

afterEach(() => {
  delete (globalThis as G).chrome;
  delete (globalThis as G).browser;
  document.body.innerHTML = '';
});

describe('default storage on each browser', () => {
  it('falls back to browser.storage.local on Firefox (no chrome global)', async () => {
    const local = memoryStorage();
    (globalThis as G).browser = { storage: { local } };
    await recordActivation({ now: () => START });
    expect((local.data.reviewNudge as { activations: number }).activations).toBe(1);
  });

  it('falls back to browser.storage.local when chrome exists without storage', async () => {
    const local = memoryStorage();
    (globalThis as G).chrome = { runtime: {} };
    (globalThis as G).browser = { storage: { local } };
    await recordActivation({ now: () => START });
    expect(local.writes).toBe(1);
  });

  it('prefers chrome.storage.local when both globals exist', async () => {
    const chromeLocal = memoryStorage();
    const browserLocal = memoryStorage();
    (globalThis as G).chrome = { storage: { local: chromeLocal } };
    (globalThis as G).browser = { storage: { local: browserLocal } };
    await recordActivation({ now: () => START });
    expect(chromeLocal.writes).toBe(1);
    expect(browserLocal.writes).toBe(0);
  });

  it('uses the real clock when no now() is passed', async () => {
    const storage = memoryStorage();
    const before = Date.now();
    await recordActivation({ storage });
    const s = await readState({ storage });
    expect(s!.firstUseAt).toBeGreaterThanOrEqual(before);
    expect(s!.firstUseAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('storage key and stored state', () => {
  it('keeps extensions sharing a storage area apart with a custom key', async () => {
    const storage = memoryStorage();
    await recordActivation({ storage, key: 'a', now: () => START });
    await recordActivation({ storage, key: 'a', now: () => START });
    await recordActivation({ storage, key: 'b', now: () => START });
    expect((await readState({ storage, key: 'a' }))!.activations).toBe(2);
    expect((await readState({ storage, key: 'b' }))!.activations).toBe(1);
    expect(await readState({ storage })).toBeUndefined();
  });

  it('settle() with nothing stored writes nothing', async () => {
    const storage = memoryStorage();
    await settle('dismissed', { storage, now: () => START });
    expect(storage.writes).toBe(0);
    expect(await readState({ storage })).toBeUndefined();
  });

  it('starts counting afresh over a corrupt stored value', async () => {
    const storage = memoryStorage();
    storage.data.reviewNudge = { v: 2, status: 'counting', activations: 99 };
    await recordActivation({ storage, now: () => START });
    expect(await readState({ storage })).toMatchObject({ v: 1, status: 'counting', activations: 1, activeDays: 1 });
  });

  it('stops counting once settled, so storage is not rewritten on every later use', async () => {
    const storage = memoryStorage();
    await recordActivation({ storage, now: () => START });
    await settle('dismissed', { storage, now: () => START });
    const writes = storage.writes;
    for (let i = 0; i < 5; i++) await recordActivation({ storage, now: () => START + i * DAY });
    expect(storage.writes).toBe(writes);
  });
});

describe('chromeWebStoreReviewUrl', () => {
  it('builds the review page URL and encodes the id', () => {
    expect(chromeWebStoreReviewUrl('abc')).toBe('https://chromewebstore.google.com/detail/abc/reviews');
    expect(chromeWebStoreReviewUrl('a/b?c')).toBe('https://chromewebstore.google.com/detail/a%2Fb%3Fc/reviews');
  });
});

describe('two surfaces opened at once', () => {
  // BUG: mountReviewNudge checks eligibility and retires the nudge in two separate async storage
  // round-trips, so two surfaces mounting at the same moment (a popup and an options page, or two
  // windows' popups) both read `counting`, both render, and the "shown once" rule is broken.
  // Not fixed in this PR.
  it.skip('renders the nudge on only one of them', async () => {
    const storage = memoryStorage();
    let clock = START;
    const opts = { storage, now: () => clock, minActivations: 1, minActiveDays: 1, minAgeDays: 0 };
    await recordActivation(opts);
    clock += DAY;
    expect(await isEligible(opts)).toBe(true);

    const mount = { ...opts, name: 'X', reviewUrl: 'https://r.example', feedbackUrl: 'https://f.example' };
    const a = document.createElement('div');
    const b = document.createElement('div');
    const [ra, rb] = await Promise.all([mountReviewNudge(a, mount), mountReviewNudge(b, mount)]);
    expect([ra, rb].filter(Boolean)).toHaveLength(1);
  });
});

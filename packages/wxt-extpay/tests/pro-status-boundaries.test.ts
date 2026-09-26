import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTrialActive, trialDaysRemaining, resolveProStatus, statusLabel } from '../src/pro-status';

// Pinned clock: the existing pro-status tests read the real clock; these sit exactly on edges.
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-26T12:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('trial boundaries', () => {
  it('is active 1 ms before the trial ends, with 1 day left', () => {
    const start = ago(7 * DAY - 1);
    expect(isTrialActive(start, 7)).toBe(true);
    expect(trialDaysRemaining(start, 7)).toBe(1);
  });

  it('ends exactly at trialDays, with 0 days left', () => {
    const start = ago(7 * DAY);
    expect(isTrialActive(start, 7)).toBe(false);
    expect(trialDaysRemaining(start, 7)).toBe(0);
  });

  it('rounds partial days up: 2.5 days in to a 7-day trial leaves 5', () => {
    expect(trialDaysRemaining(ago(2.5 * DAY), 7)).toBe(5);
  });

  it('trialDays 0 means no trial, even if one was started', () => {
    const status = resolveProStatus({ paid: false, paidAt: null, trialStartedAt: ago(0) }, 0);
    expect(status).toMatchObject({ unlocked: false, trialActive: false, trialDaysLeft: 0 });
    expect(statusLabel(status)).toBe('Free');
  });

  it('never unlocks while showing 0 days left, or locks while showing days left', () => {
    for (let h = 0; h <= 8 * 24; h++) {
      const s = resolveProStatus({ paid: false, paidAt: null, trialStartedAt: ago(h * 60 * 60 * 1000) }, 7);
      expect(s.trialActive, `at ${h}h`).toBe(s.trialDaysLeft > 0);
      expect(s.unlocked, `at ${h}h`).toBe(s.trialActive);
    }
  });

  it('uses the 7-day default when trialDays is omitted', () => {
    expect(resolveProStatus({ paid: false, paidAt: null, trialStartedAt: ago(6 * DAY) }).trialActive).toBe(true);
    expect(resolveProStatus({ paid: false, paidAt: null, trialStartedAt: ago(7 * DAY) }).trialActive).toBe(false);
  });

  // Guards against a user clock running behind the ExtensionPay server's trialStartedAt.
  it('never reports more days left than the trial length, even with clock skew', () => {
    const inFuture = new Date(NOW + 2 * DAY);
    expect(trialDaysRemaining(inFuture, 7)).toBeLessThanOrEqual(7);
  });

  it('treats a trial started in the future as just started, keeping status and days consistent', () => {
    const inFuture = new Date(NOW + 2 * DAY);
    expect(resolveProStatus({ paid: false, paidAt: null, trialStartedAt: inFuture }, 7)).toMatchObject({ trialActive: true, trialDaysLeft: 7 });
    expect(resolveProStatus({ paid: false, paidAt: null, trialStartedAt: inFuture }, 0)).toMatchObject({ unlocked: false, trialActive: false, trialDaysLeft: 0 });
  });
});

describe('paid users', () => {
  it('stay unlocked and labelled Pro during an active trial', () => {
    const paidAt = ago(DAY);
    const s = resolveProStatus({ paid: true, paidAt, trialStartedAt: ago(DAY) }, 7);
    expect(s).toMatchObject({ unlocked: true, paid: true, paidAt, trialActive: true });
    expect(statusLabel(s)).toBe('Pro');
  });
});

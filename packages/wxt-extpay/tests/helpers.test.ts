import { describe, it, expect } from 'vitest';
import {
  isTrialActive,
  trialDaysRemaining,
  resolveProStatus,
  statusLabel,
  type PaymentUser,
} from '../src/pro-status';

describe('isTrialActive', () => {
  it('returns false when trialStartedAt is null', () => {
    expect(isTrialActive(null)).toBe(false);
  });

  it('returns true when trial just started', () => {
    expect(isTrialActive(new Date(), 7)).toBe(true);
  });

  it('returns true on day 6 of 7-day trial', () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    expect(isTrialActive(sixDaysAgo, 7)).toBe(true);
  });

  it('returns false when trial expired', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(isTrialActive(eightDaysAgo, 7)).toBe(false);
  });

  it('respects custom trial duration', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(isTrialActive(twoDaysAgo, 3)).toBe(true);
    expect(isTrialActive(twoDaysAgo, 1)).toBe(false);
  });
});

describe('trialDaysRemaining', () => {
  it('returns 0 when trialStartedAt is null', () => {
    expect(trialDaysRemaining(null)).toBe(0);
  });

  it('returns full days when trial just started', () => {
    expect(trialDaysRemaining(new Date(), 7)).toBe(7);
  });

  it('returns 0 when trial expired', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    expect(trialDaysRemaining(tenDaysAgo, 7)).toBe(0);
  });

  it('returns correct remaining days mid-trial', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(trialDaysRemaining(threeDaysAgo, 7)).toBe(4);
  });
});

describe('resolveProStatus', () => {
  const unpaidNoTrial: PaymentUser = { paid: false, paidAt: null, trialStartedAt: null };
  const paidUser: PaymentUser = { paid: true, paidAt: new Date(), trialStartedAt: null };
  const trialUser: PaymentUser = { paid: false, paidAt: null, trialStartedAt: new Date() };
  const expiredTrialUser: PaymentUser = {
    paid: false,
    paidAt: null,
    trialStartedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  };
  const paidWithTrial: PaymentUser = {
    paid: true,
    paidAt: new Date(),
    trialStartedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  };

  it('unpaid + no trial = locked', () => {
    const status = resolveProStatus(unpaidNoTrial);
    expect(status.unlocked).toBe(false);
    expect(status.paid).toBe(false);
    expect(status.trialActive).toBe(false);
  });

  it('paid user = unlocked', () => {
    const status = resolveProStatus(paidUser);
    expect(status.unlocked).toBe(true);
    expect(status.paid).toBe(true);
  });

  it('active trial = unlocked', () => {
    const status = resolveProStatus(trialUser);
    expect(status.unlocked).toBe(true);
    expect(status.paid).toBe(false);
    expect(status.trialActive).toBe(true);
    expect(status.trialDaysLeft).toBeGreaterThan(0);
  });

  it('expired trial = locked', () => {
    const status = resolveProStatus(expiredTrialUser);
    expect(status.unlocked).toBe(false);
    expect(status.trialActive).toBe(false);
    expect(status.trialDaysLeft).toBe(0);
  });

  it('paid + expired trial = unlocked (paid wins)', () => {
    const status = resolveProStatus(paidWithTrial);
    expect(status.unlocked).toBe(true);
    expect(status.paid).toBe(true);
  });
});

describe('statusLabel', () => {
  it('returns "Pro" for paid users', () => {
    expect(statusLabel({ unlocked: true, paid: true, paidAt: new Date(), trialActive: false, trialDaysLeft: 0 })).toBe('Pro');
  });

  it('returns "Trial (Xd left)" for trial users', () => {
    const label = statusLabel({ unlocked: true, paid: false, paidAt: null, trialActive: true, trialDaysLeft: 5 });
    expect(label).toBe('Trial (5d left)');
  });

  it('returns "Free" for unpaid users', () => {
    expect(statusLabel({ unlocked: false, paid: false, paidAt: null, trialActive: false, trialDaysLeft: 0 })).toBe('Free');
  });
});

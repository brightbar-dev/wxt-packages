/**
 * Pure functions for pro status resolution — no browser dependencies.
 * Safe to import in tests and any context.
 */

// ── Types ──────────────────────────────────────────────────

export interface PaymentUser {
  paid: boolean;
  paidAt: Date | null;
  trialStartedAt: Date | null;
}

export interface ProStatus {
  unlocked: boolean;
  paid: boolean;
  paidAt: Date | null;
  trialActive: boolean;
  trialDaysLeft: number;
}

export interface ExtPayConfig {
  extensionId: string;
  priceDisplay: string;
  priceLabel: string;
  trialDays: number;
}

// ── Pro status resolution ──────────────────────────────────

/** Check if a trial is still active given its start date */
export function isTrialActive(trialStartedAt: Date | null, trialDays: number = 7): boolean {
  if (!trialStartedAt) return false;
  const elapsed = Date.now() - trialStartedAt.getTime();
  return elapsed < trialDays * 24 * 60 * 60 * 1000;
}

/** Days remaining in trial (0 if expired or not started) */
export function trialDaysRemaining(trialStartedAt: Date | null, trialDays: number = 7): number {
  if (!trialStartedAt) return 0;
  const elapsed = Date.now() - trialStartedAt.getTime();
  const remaining = trialDays - elapsed / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.ceil(remaining));
}

/** Resolve full pro status from ExtPay user data */
export function resolveProStatus(user: PaymentUser, trialDays: number = 7): ProStatus {
  const trialActive = isTrialActive(user.trialStartedAt, trialDays);
  return {
    unlocked: user.paid || trialActive,
    paid: user.paid,
    paidAt: user.paidAt,
    trialActive,
    trialDaysLeft: trialDaysRemaining(user.trialStartedAt, trialDays),
  };
}

/** Format pro status for display */
export function statusLabel(status: ProStatus): string {
  if (status.paid) return 'Pro';
  if (status.trialActive) return `Trial (${status.trialDaysLeft}d left)`;
  return 'Free';
}

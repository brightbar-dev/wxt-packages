/**
 * A request for a store review that a user sees at most once, and only after real use.
 *
 * The rules, each enforced here rather than left to the caller:
 * - Never on install: the first counted use must be at least `minAgeDays` old.
 * - Only after real use: `minActivations` successful uses, spread over `minActiveDays` distinct days.
 *   The extension calls `recordActivation()` when a use succeeds (a document formatted, a request
 *   answered), never on a mere open.
 * - Shown once: the nudge retires the moment it is rendered, whatever the user then does.
 * - "Don't ask again" is final: once the nudge has left the `counting` state, nothing re-arms it.
 * - Problems go elsewhere: the nudge carries a separate link to a feedback form, so an unhappy user
 *   is not steered to the store.
 *
 * Never mid-task is the caller's half: mount it only on a surface the user has just opened (a popup,
 * the start page of an app tab), never inside an overlay or while a tool is running.
 */

export type NudgeStatus = 'counting' | 'shown' | 'reviewed' | 'feedback' | 'dismissed';

export interface NudgeState {
  v: 1;
  status: NudgeStatus;
  /** When the first successful use was counted (ms since epoch). */
  firstUseAt: number;
  activations: number;
  /** Distinct local calendar days with at least one counted use. */
  activeDays: number;
  /** The local day (YYYY-MM-DD) of the last counted use. */
  lastDay: string;
  shownAt?: number;
}

/** The subset of chrome.storage.local this needs. */
export interface NudgeStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface NudgeOptions {
  /** Default: chrome.storage.local (browser.storage.local on Firefox). */
  storage?: NudgeStorage;
  now?: () => number;
  /** Successful uses required. Default 8. */
  minActivations?: number;
  /** Distinct days with a successful use required. Default 3. */
  minActiveDays?: number;
  /** Days since the first counted use. Default 5. */
  minAgeDays?: number;
  /** Storage key. Default "reviewNudge". */
  key?: string;
}

const DAY_MS = 86_400_000;

type StorageHost = { storage?: { local?: NudgeStorage } };

function defaultStorage(): NudgeStorage {
  const g = globalThis as { chrome?: StorageHost; browser?: StorageHost };
  const local = g.chrome?.storage?.local ?? g.browser?.storage?.local;
  if (!local) throw new Error('review-nudge: no storage.local; pass options.storage');
  return local;
}

function settings(o: NudgeOptions) {
  return {
    storage: o.storage ?? defaultStorage(),
    now: o.now ?? Date.now,
    minActivations: o.minActivations ?? 8,
    minActiveDays: o.minActiveDays ?? 3,
    minAgeDays: o.minAgeDays ?? 5,
    key: o.key ?? 'reviewNudge',
  };
}

/** The user's local calendar day, so "a few days" means days as the user lives them. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isState(x: unknown): x is NudgeState {
  const s = x as NudgeState | undefined;
  return !!s && s.v === 1 && typeof s.status === 'string' && typeof s.activations === 'number';
}

export async function readState(options: NudgeOptions = {}): Promise<NudgeState | undefined> {
  const { storage, key } = settings(options);
  const got = (await storage.get(key))[key];
  return isState(got) ? got : undefined;
}

async function write(options: NudgeOptions, state: NudgeState): Promise<void> {
  const { storage, key } = settings(options);
  await storage.set({ [key]: state });
}

/** Count one successful use. Does nothing once the nudge has been shown or declined. */
export async function recordActivation(options: NudgeOptions = {}): Promise<void> {
  const { now } = settings(options);
  const t = now();
  const today = localDay(t);
  const s = await readState(options);
  if (!s) {
    await write(options, { v: 1, status: 'counting', firstUseAt: t, activations: 1, activeDays: 1, lastDay: today });
    return;
  }
  if (s.status !== 'counting') return;
  await write(options, {
    ...s,
    activations: s.activations + 1,
    activeDays: s.lastDay === today ? s.activeDays : s.activeDays + 1,
    lastDay: today,
  });
}

/** True only while counting and every threshold is met. */
export async function isEligible(options: NudgeOptions = {}): Promise<boolean> {
  const { now, minActivations, minActiveDays, minAgeDays } = settings(options);
  const s = await readState(options);
  if (!s || s.status !== 'counting') return false;
  return s.activations >= minActivations && s.activeDays >= minActiveDays && now() - s.firstUseAt >= minAgeDays * DAY_MS;
}

/**
 * Move out of `counting` for good. `shown` is recorded as the nudge renders; the user's choice
 * (reviewed, feedback, dismissed) then replaces it, for the record only.
 */
export async function settle(status: Exclude<NudgeStatus, 'counting'>, options: NudgeOptions = {}): Promise<void> {
  const { now } = settings(options);
  const s = await readState(options);
  if (!s) return;
  await write(options, { ...s, status, shownAt: s.shownAt ?? now() });
}

export function chromeWebStoreReviewUrl(extensionId: string): string {
  return `https://chromewebstore.google.com/detail/${encodeURIComponent(extensionId)}/reviews`;
}

export interface NudgeStrings {
  /** Receives the extension's name. */
  prompt: (name: string) => string;
  review: string;
  feedback: string;
  dismiss: string;
}

export const englishStrings: NudgeStrings = {
  prompt: (name) => `Is ${name} useful to you?`,
  review: 'Leave a review',
  feedback: 'Something wrong? Tell us',
  dismiss: 'Don’t ask again',
};

export interface MountOptions extends NudgeOptions {
  /** The extension's display name, as the user knows it. */
  name: string;
  /** This extension's store review page; see chromeWebStoreReviewUrl. */
  reviewUrl: string;
  /** Where a problem goes instead: an issue form or feedback page. */
  feedbackUrl: string;
  strings?: Partial<NudgeStrings>;
}

/**
 * Render the one-line nudge at the end of `container` if the user has earned it, and retire it
 * in the same step. Returns the element, or null when nothing was shown.
 */
export async function mountReviewNudge(container: HTMLElement, options: MountOptions): Promise<HTMLElement | null> {
  if (!(await isEligible(options))) return null;
  // Retire first: a popup closed a moment after opening must not earn a second showing.
  await settle('shown', options);

  const str = { ...englishStrings, ...options.strings };
  const doc = container.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'bb-review-nudge';
  root.setAttribute('role', 'note');

  const text = doc.createElement('span');
  text.textContent = `${str.prompt(options.name)} `;
  root.append(text);

  const link = (href: string, label: string, outcome: 'reviewed' | 'feedback') => {
    const a = doc.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    a.addEventListener('click', () => {
      void settle(outcome, options);
      root.remove();
    });
    return a;
  };
  root.append(link(options.reviewUrl, str.review, 'reviewed'), doc.createTextNode(' · '), link(options.feedbackUrl, str.feedback, 'feedback'));

  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'bb-review-nudge-dismiss';
  close.textContent = str.dismiss;
  close.addEventListener('click', () => {
    void settle('dismissed', options);
    root.remove();
  });
  root.append(close);

  container.append(root);
  return root;
}

/**
 * Minimal styles that take the host page's font and colours; override the custom properties to
 * theme it. Inject once, for example with a <style> element. Nothing is dimmed: an extension's muted
 * text colour at 70% opacity fell below 4.5:1 in all four Brightbar extensions (2026-09-24).
 */
export const reviewNudgeCss = `.bb-review-nudge{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25em;padding:var(--bb-nudge-padding,.5em .75em);font:inherit;font-size:var(--bb-nudge-font-size,.85em);color:var(--bb-nudge-color,inherit);border-top:1px solid var(--bb-nudge-border,color-mix(in srgb,currentColor 15%,transparent))}
.bb-review-nudge a{color:var(--bb-nudge-link,inherit)}
.bb-review-nudge-dismiss{margin-left:auto;font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-decoration:underline}
.bb-review-nudge-dismiss:hover,.bb-review-nudge-dismiss:focus-visible{text-decoration-thickness:2px}`;

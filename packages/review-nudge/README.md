# @brightbar-dev/review-nudge

Asks for a Chrome Web Store review once, and only after someone has really used the extension. The same line offers a separate link for reporting a problem, so unhappy users aren't sent to the store.

The rules are enforced by the package (`tests/review-nudge.test.ts` pins each one):

| Rule | Default |
|---|---|
| Never on install | first counted use at least `minAgeDays` (5) ago |
| Only after real use | `minActivations` (8) successful uses over `minActiveDays` (3) distinct local days |
| Shown once | retired the moment it renders, whether or not the user clicks anything |
| "Don't ask again" is final | nothing moves the state back to `counting` |
| Problems go elsewhere | a second link to `feedbackUrl` (an issue form), never the store |

## Use

```ts
import { recordActivation, mountReviewNudge, chromeWebStoreReviewUrl, reviewNudgeCss } from '@brightbar-dev/review-nudge';

// Where a use SUCCEEDS (a document formatted, a request answered). Not on a mere open.
await recordActivation();

// On a surface the user has just opened (popup, the start of an app tab), never in an overlay
// or while a tool runs. That part is the caller's to get right.
document.head.append(Object.assign(document.createElement('style'), { textContent: reviewNudgeCss }));
await mountReviewNudge(document.querySelector('footer')!, {
  name: 'JSON Viewer Pro',
  reviewUrl: chromeWebStoreReviewUrl('iodhhjpjemdfmmfffmejfnbbjbfafoac'),
  feedbackUrl: 'https://github.com/brightbar-dev/json-viewer-pro/issues/new/choose',
  strings: { /* optional: prompt, review, feedback, dismiss, from _locales */ },
});
```

State lives in `storage.local` under `reviewNudge` (so the manifest needs `storage`; every Brightbar extension already has it). Only the counters and the outcome are stored.

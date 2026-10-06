# store-publish — Firefox (AMO) and Edge Add-ons release steps

One implementation, called by every brightbar-dev extension's `release.yml` (and its `ci.yml` as a
dry run). The Chrome Web Store step stays in each extension (`scripts/cws-publish.sh`).

It lives here, not in org-work, because org-work is private and the extensions are public: a public
repository cannot use an action stored in a private one.

| Action | What it does | Credentials (Actions secrets) |
|---|---|---|
| `brightbar-dev/wxt-packages/store-publish/amo@<sha>` | `bin/amo-check.sh`: web-ext lint, make the sources zip reviewer-buildable, rebuild from it with no registry credentials and require a byte-identical package. Then `bin/amo-publish.sh`: AMO API v5 upload → validation → new version (or, the first time, the add-on from `store/amo.json`) with the sources attached. | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` |
| `brightbar-dev/wxt-packages/store-publish/edge@<sha>` | `bin/edge-publish.sh`: Edge Add-ons API v1.1 upload to the draft → submit for certification. Update only: the product must already exist in Partner Center. | `EDGE_CLIENT_ID`, `EDGE_API_KEY` |

Both take `build-only: true`, which checks everything that can be checked offline and makes no store
call (the mirror of `CWS_BUILD_ONLY`). An extension's workflow passes `build-only: true` until its repo
variable `AMO_ENABLED` / `EDGE_ENABLED` is `true`, so every release proves the path before a store
account exists. Turning a store on for a product is a launch: that is joint with Ken (org-work RUNBOOK §7).

Each extension needs, for Firefox: `browser_specific_settings.gecko.id` and
`gecko.data_collection_permissions` in its Firefox manifest, `zip.downloadPackages` listing its private
`@brightbar-dev/*` packages (AMO reviewers cannot reach GitHub Packages), and `store/amo.json` for the
first listed submission. For Edge: repo variable `EDGE_PRODUCT_ID` (Partner Center's product GUID).

Pin callers to a full commit SHA, as with every third-party action here.

**Tests:** `node --test store-publish/tests/*.test.mjs` runs both publish scripts against a stub `curl`
(CI does). `amo-check.sh` is proven by the extensions' CI, which runs it on a real build.

**Staying true:** repair-on-touch. A store API change shows up as a failed release job; fix the script,
its test and this table in the same PR.

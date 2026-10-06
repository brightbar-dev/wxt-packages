#!/usr/bin/env bash
# edge-publish.sh - upload the built Chrome MV3 zip to this extension's Microsoft Edge Add-ons product
# and, unless EDGE_AUTO_PUBLISH=false, submit it for certification.
#
# Uses the Edge Add-ons update REST API v1.1, API-key auth
# (https://learn.microsoft.com/microsoft-edge/extensions/update/api/using-addons-api). The API updates
# an existing product only: the first submission, and all listing text and images, are Partner Center.
#
# Called by store-publish/edge/action.yml. tests/edge-publish.test.mjs runs it against a stub curl.
#
# Env
#   EDGE_CLIENT_ID, EDGE_API_KEY   from Partner Center > Microsoft Edge > Publish API (Actions secrets).
#                                  API keys expire; Partner Center shows the date
#   EDGE_PRODUCT_ID   the product's Partner Center GUID (not the store's crx ID)
#   EDGE_BUILD_ONLY   "true": check the package, then stop. No network, no credential. The dry run
#   EDGE_AUTO_PUBLISH "false": upload to the draft only, do not submit for certification
#   EDGE_NOTES        notes for certification (default names the version and the source repo)
#   EDGE_ZIP          the package (default: the single .output/*-chrome.zip)
#   EDGE_POLL_SECONDS wait between status polls (default 5)
#   EDGE_POLL_MAX     status polls before giving up (default 60)
#   EDGE_API_BASE     test seam; default https://api.addons.microsoftedge.microsoft.com
set -euo pipefail

api="${EDGE_API_BASE:-https://api.addons.microsoftedge.microsoft.com}"
fail() { echo "edge-publish: $*" >&2; exit 1; }

# 1. The package, checked before any credential is used.
zip="${EDGE_ZIP:-}"
if [ -z "$zip" ]; then
  shopt -s nullglob
  zips=(.output/*-chrome.zip)
  shopt -u nullglob
  [ "${#zips[@]}" -eq 1 ] || fail "expected exactly one .output/*-chrome.zip, found ${#zips[@]}"
  zip=${zips[0]}
fi
[ -f "$zip" ] || fail "no such package: $zip"
manifest=$(unzip -p "$zip" manifest.json 2>/dev/null) || fail "$zip has no manifest.json"
mv=$(jq -r '.manifest_version // empty' <<<"$manifest")
version=$(jq -r '.version // empty' <<<"$manifest")
[ "$mv" = 3 ] || fail "$zip is manifest_version ${mv:-missing}; Edge Add-ons takes MV3"
[ -n "$version" ] || fail "$zip: manifest has no version"
echo "Package: $zip ($version)"

if [ "${EDGE_BUILD_ONLY:-}" = true ]; then
  echo "EDGE_BUILD_ONLY=true: checked $zip, uploaded nothing."
  exit 0
fi

product="${EDGE_PRODUCT_ID:?EDGE_PRODUCT_ID is required}"
auth=(-H "Authorization: ApiKey ${EDGE_API_KEY:?EDGE_API_KEY is required}" -H "X-ClientID: ${EDGE_CLIENT_ID:?EDGE_CLIENT_ID is required}")
base="$api/v1/products/$product/submissions"

describe() {
  local msg
  msg=$(jq -r '[.message, .errorCode, ((.errors // []) | map(if type == "object" then .message else tostring end) | join("; "))]
    | map(select(. != null and . != "")) | join(" | ")' <<<"$1" 2>/dev/null || true)
  [ -n "$msg" ] || msg=$(printf '%s' "$1" | head -c 300)
  printf '%s' "$msg"
}

# call <curl args>: sets BODY, CODE and LOCATION (the operation ID the 202s return).
call() {
  local out headers
  headers=$(mktemp)
  out=$(curl -sS -D "$headers" -w $'\n%{http_code}' "${auth[@]}" "$@") || { rm -f "$headers"; fail "curl failed"; }
  CODE=${out##*$'\n'}
  BODY=${out%$'\n'*}
  LOCATION=$(tr -d '\r' <"$headers" | awk 'tolower($1) == "location:" { print $2 }' | tail -1)
  LOCATION=${LOCATION##*/}
  rm -f "$headers"
}

# poll <status url> <what>: waits out InProgress; sets BODY to the final status.
poll() {
  local url=$1 what=$2 polls=0 status
  while :; do
    call "$url"
    [ "$CODE" = 200 ] || fail "$what status failed (HTTP $CODE): $(describe "$BODY")"
    status=$(jq -r '.status // "MISSING"' <<<"$BODY")
    [ "$status" = InProgress ] || break
    polls=$((polls + 1))
    [ "$polls" -le "${EDGE_POLL_MAX:-60}" ] || fail "$what still in progress after $polls polls"
    sleep "${EDGE_POLL_SECONDS:-5}"
  done
  [ "$status" = Succeeded ] || fail "$what $status: $(describe "$BODY")"
}

# 2. Upload to the draft submission.
call -X POST "$base/draft/package" -H 'Content-Type: application/zip' -T "$zip"
[ "$CODE" = 202 ] || fail "upload rejected (HTTP $CODE): $(describe "$BODY")"
[ -n "$LOCATION" ] || fail "upload accepted but no operation ID came back"
poll "$base/draft/package/operations/$LOCATION" upload
echo "Upload: Succeeded ($version): $(jq -r '.message // ""' <<<"$BODY")"

if [ "${EDGE_AUTO_PUBLISH:-}" = false ]; then
  echo "EDGE_AUTO_PUBLISH=false: package uploaded to the draft, NOT submitted for certification."
  exit 0
fi

# 3. Submit for certification (up to 7 business days). InProgressSubmission means the previous
#    version is still in review: the draft keeps this package, and a later publish call submits it.
notes="${EDGE_NOTES:-Version $version, built from ${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-} by its release workflow.}"
call -X POST "$base" -H 'Content-Type: application/json' -d "$(jq -nc --arg n "$notes" '{notes: $n}')"
[ "$CODE" = 202 ] || fail "publish rejected (HTTP $CODE): $(describe "$BODY")"
[ -n "$LOCATION" ] || fail "publish accepted but no operation ID came back"
poll "$base/operations/$LOCATION" publish
echo "Publish: Succeeded ($version): $(jq -r '.message // ""' <<<"$BODY")"

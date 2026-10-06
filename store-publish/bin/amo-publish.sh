#!/usr/bin/env bash
# amo-publish.sh - submit the built Firefox zip, with its sources zip, to addons.mozilla.org (AMO).
#
# Uses the AMO add-on submission API v5 (https://mozilla.github.io/addons-server/topics/api/addons.html):
# upload the package, wait for AMO's validator, then create a version of the existing add-on (or,
# on the very first submission, the add-on itself from store/amo.json) and attach the sources zip.
# A listed version is then reviewed by AMO; nothing here waits for that.
#
# Called by store-publish/amo/action.yml after amo-check.sh has linted the package and proved the
# sources zip rebuilds it. tests/amo-publish.test.mjs runs it against a stub curl.
#
# Env
#   AMO_JWT_ISSUER, AMO_JWT_SECRET   the API key pair from https://addons.mozilla.org/developers/addon/api/key/
#                                    (Actions secrets). Every request gets a fresh HS256 JWT (5-minute expiry)
#   AMO_BUILD_ONLY   "true": check the packages, then stop. No network, no credential. The dry run
#   AMO_CHANNEL      listed (default) or unlisted
#   AMO_ZIP          the package (default: the single .output/*-firefox.zip)
#   AMO_SOURCES_ZIP  the sources (default: the single .output/*-sources.zip)
#   AMO_METADATA     listing metadata used ONLY when the add-on does not exist yet (default store/amo.json):
#                    {"categories":{"firefox":[...]}, "summary":{"en-US":"..."}, "version":{"license":"MIT"}, ...}
#                    Any other add-on-create field (homepage, support_url, support_email, tags) passes through
#   AMO_POLL_SECONDS wait between validation polls (default 5)
#   AMO_POLL_MAX     validation polls before giving up (default 60)
#   AMO_API_BASE     test seam; default https://addons.mozilla.org/api/v5
set -euo pipefail

api="${AMO_API_BASE:-https://addons.mozilla.org/api/v5}"
channel="${AMO_CHANNEL:-listed}"

fail() { echo "amo-publish: $*" >&2; exit 1; }

# The single file matching a glob, or the override.
one() {
  local override=$1 pattern=$2 what=$3 files
  if [ -n "$override" ]; then
    [ -f "$override" ] || fail "no such $what: $override"
    printf '%s' "$override"
    return
  fi
  shopt -s nullglob
  # shellcheck disable=SC2206
  files=($pattern)
  shopt -u nullglob
  [ "${#files[@]}" -eq 1 ] || fail "expected exactly one $pattern, found ${#files[@]}"
  printf '%s' "${files[0]}"
}

# 1. The packages, checked before any credential is used.
zip=$(one "${AMO_ZIP:-}" '.output/*-firefox.zip' package)
sources=$(one "${AMO_SOURCES_ZIP:-}" '.output/*-sources.zip' 'sources zip')
manifest=$(unzip -p "$zip" manifest.json 2>/dev/null) || fail "$zip has no manifest.json"
guid=$(jq -r '.browser_specific_settings.gecko.id // empty' <<<"$manifest")
version=$(jq -r '.version // empty' <<<"$manifest")
[ -n "$guid" ] || fail "$zip: manifest has no browser_specific_settings.gecko.id; AMO needs a stable add-on ID"
[ -n "$version" ] || fail "$zip: manifest has no version"
jq -e '.browser_specific_settings.gecko.data_collection_permissions.required | type == "array" and length > 0' \
  <<<"$manifest" >/dev/null \
  || fail "$zip: manifest has no gecko.data_collection_permissions.required; AMO refuses new add-ons without it"
case "$channel" in listed | unlisted) ;; *) fail "AMO_CHANNEL must be listed or unlisted, not $channel" ;; esac
echo "Package: $zip ($guid $version, $channel), sources $sources"

if [ "${AMO_BUILD_ONLY:-}" = true ]; then
  echo "AMO_BUILD_ONLY=true: checked $zip and $sources, submitted nothing."
  exit 0
fi

: "${AMO_JWT_ISSUER:?AMO_JWT_ISSUER is required}"
: "${AMO_JWT_SECRET:?AMO_JWT_SECRET is required}"

# A fresh JWT per request: AMO rejects a reused jti and an exp more than 5 minutes past iat. Node
# signs it so the secret stays in the environment and never reaches a command line.
jwt() {
  node -e '
    const { createHmac, randomUUID } = require("node:crypto");
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const iat = Math.floor(Date.now() / 1000);
    const body = b({ alg: "HS256", typ: "JWT" }) + "." +
      b({ iss: process.env.AMO_JWT_ISSUER, jti: randomUUID(), iat, exp: iat + 240 });
    process.stdout.write(body + "." + createHmac("sha256", process.env.AMO_JWT_SECRET).update(body).digest("base64url"));
  '
}

# The API's own message when the body says one, else its first 300 characters.
describe() {
  local msg
  msg=$(jq -r 'if type == "object" then (.detail // .error // ([to_entries[] | "\(.key): \(.value|tostring)"] | join("; "))) else tostring end' \
    <<<"$1" 2>/dev/null || true)
  [ -n "$msg" ] || msg=$(printf '%s' "$1" | head -c 300)
  printf '%s' "$msg" | head -c 600
}

# call <curl args>: sets BODY and CODE, authenticated.
call() {
  local out
  out=$(curl -sS -w $'\n%{http_code}' -H "Authorization: JWT $(jwt)" "$@") || fail "curl failed"
  CODE=${out##*$'\n'}
  BODY=${out%$'\n'*}
}

# 2. Upload and wait for AMO's validator.
call -X POST "$api/addons/upload/" -F "upload=@$zip" -F "channel=$channel"
[ "$CODE" = 201 ] || [ "$CODE" = 200 ] || fail "upload rejected (HTTP $CODE): $(describe "$BODY")"
uuid=$(jq -r '.uuid // empty' <<<"$BODY")
[ -n "$uuid" ] || fail "upload response has no uuid"
polls=0
while [ "$(jq -r '.processed' <<<"$BODY")" != true ]; do
  polls=$((polls + 1))
  [ "$polls" -le "${AMO_POLL_MAX:-60}" ] || fail "validation still running after $((polls - 1)) polls (upload $uuid)"
  sleep "${AMO_POLL_SECONDS:-5}"
  call "$api/addons/upload/$uuid/"
  [ "$CODE" = 200 ] || fail "upload status failed (HTTP $CODE): $(describe "$BODY")"
done
if [ "$(jq -r '.valid' <<<"$BODY")" != true ]; then
  jq -r '(.validation.messages // [])[] | select(.type == "error") | "error: \(.message) \(.file // "")"' <<<"$BODY" >&2 || true
  fail "AMO validation failed for upload $uuid ($(jq -r '.validation.errors // "?"' <<<"$BODY") errors)"
fi
echo "Validated: upload $uuid ($(jq -r '.validation.warnings // 0' <<<"$BODY") warnings)"

# 3. A new version of the existing add-on, or the add-on itself on its first submission.
call "$api/addons/addon/$guid/"
if [ "$CODE" = 200 ]; then
  call -X POST "$api/addons/addon/$guid/versions/" -F "upload=$uuid" -F "source=@$sources"
  [ "$CODE" = 201 ] || fail "version create rejected (HTTP $CODE): $(describe "$BODY")"
  vid=$(jq -r '.id' <<<"$BODY")
elif [ "$CODE" = 404 ]; then
  metadata="${AMO_METADATA:-store/amo.json}"
  [ -f "$metadata" ] || fail "$guid is not on AMO yet and there is no $metadata to create its listing from"
  payload=$(jq -c --arg u "$uuid" '.version = ((.version // {}) + {upload: $u})' "$metadata")
  for need in '.categories.firefox' '.summary' '.version.license'; do
    jq -e "$need" <<<"$payload" >/dev/null || fail "$metadata lacks $need, which AMO requires for a new listed add-on"
  done
  call -X POST "$api/addons/addon/" -H 'Content-Type: application/json' -d "$payload"
  [ "$CODE" = 201 ] || fail "add-on create rejected (HTTP $CODE): $(describe "$BODY")"
  echo "Created: add-on $(jq -r '.id' <<<"$BODY") ($guid)"
  vid=$(jq -r '.current_version.id // .latest_unlisted_version.id // empty' <<<"$BODY")
  [ -n "$vid" ] || fail "add-on created but the response names no version to attach the sources to"
  # Sources cannot ride along on add-on create; they go on the version afterwards.
  call -X PATCH "$api/addons/addon/$guid/versions/$vid/" -F "source=@$sources"
  [ "$CODE" = 200 ] || fail "attaching sources to version $vid failed (HTTP $CODE): $(describe "$BODY")"
else
  fail "add-on lookup failed (HTTP $CODE): $(describe "$BODY")"
fi
echo "Submitted: $guid $version as version $vid ($channel), file status $(jq -r '.file.status // "unknown"' <<<"$BODY")"

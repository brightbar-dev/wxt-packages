#!/usr/bin/env bash
# amo-check.sh - make the Firefox build AMO-ready and prove it, with no network to AMO and no credential.
#
#   1. Lint the Firefox zip with web-ext (addons-linter, the validator AMO itself runs). Errors fail.
#   2. Make the -sources.zip something an AMO reviewer can build: AMO requires source for bundled or
#      minified code, rebuilt with open tools and NO private registry access
#      (https://extensionworkshop.com/documentation/publish/source-code-submission/).
#      - WXT's zip.downloadPackages puts private packages in .wxt/local_modules and points package.json
#        "resolutions" at them, which pnpm ignores. Those entries become pnpm-workspace.yaml overrides.
#      - AMO-REVIEWER-BUILD.md is added with the exact commands.
#   3. Rebuild from that sources zip exactly as the reviewer would (fresh store, no npm credentials) and
#      require every file to match the Firefox zip byte for byte. A sources zip that does not rebuild
#      the package gets the add-on rejected, so this is the check that matters.
#
# Called by store-publish/amo/action.yml in every mode, dry run included. Rewrites the sources zip in place.
#
# Env
#   AMO_ZIP, AMO_SOURCES_ZIP   as in amo-publish.sh (defaults: the single .output/*-firefox.zip / -sources.zip)
#   AMO_BUILD_COMMAND          default: pnpm exec wxt build --browser firefox
#   AMO_BUILD_OUTPUT           default: .output/firefox-mv2
#   AMO_WEB_EXT                default: web-ext@10.7.0 (pinned; bump deliberately)
#   AMO_SKIP_LINT, AMO_SKIP_REBUILD   "true" skips that step (test seams)
set -euo pipefail

fail() { echo "amo-check: $*" >&2; exit 1; }
one() {
  local override=$1 pattern=$2 files
  if [ -n "$override" ]; then printf '%s' "$override"; return; fi
  shopt -s nullglob
  # shellcheck disable=SC2206
  files=($pattern)
  shopt -u nullglob
  [ "${#files[@]}" -eq 1 ] || fail "expected exactly one $pattern, found ${#files[@]}"
  printf '%s' "${files[0]}"
}

zip=$(realpath "$(one "${AMO_ZIP:-}" '.output/*-firefox.zip')")
sources=$(realpath "$(one "${AMO_SOURCES_ZIP:-}" '.output/*-sources.zip')")
build_cmd="${AMO_BUILD_COMMAND:-pnpm exec wxt build --browser firefox}"
build_out="${AMO_BUILD_OUTPUT:-.output/firefox-mv2}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir "$work/pkg" "$work/src"
unzip -q "$zip" -d "$work/pkg"
unzip -q "$sources" -d "$work/src"

# 1. Lint.
if [ "${AMO_SKIP_LINT:-}" != true ]; then
  npx --yes "${AMO_WEB_EXT:-web-ext@10.7.0}" lint --source-dir "$work/pkg" --output json --no-input >"$work/lint.json" 2>"$work/lint.err" || true
  jq -e '.summary' "$work/lint.json" >/dev/null 2>&1 || fail "web-ext lint produced no report: $(head -c 600 "$work/lint.err")"
  jq -r '(.errors + .warnings)[] | "\(._type): \(.code) \(.file // "") \(.message)"' "$work/lint.json"
  errors=$(jq '.summary.errors' "$work/lint.json")
  echo "Lint: $errors errors, $(jq '.summary.warnings' "$work/lint.json") warnings, $(jq '.summary.notices' "$work/lint.json") notices"
  [ "$errors" -eq 0 ] || fail "web-ext lint found $errors errors; AMO would reject this package"
fi

# 2. Reviewer-buildable sources.
pm=$(jq -r '.packageManager // "npm"' "$work/src/package.json")
case "$pm" in
  pnpm@*)
    overrides=$(jq -c '[(.resolutions // {}) | to_entries[] | select(.value | startswith("file:"))
      | {name: (.key | sub("(?<=.)@[^@]+$"; "")), path: (.value | sub("^file:(//)?(\\./)?"; ""))}]' "$work/src/package.json")
    if [ "$overrides" != "[]" ]; then
      jq 'del(.resolutions)' "$work/src/package.json" >"$work/package.json" && mv "$work/package.json" "$work/src/package.json"
      grep -q '^overrides:' "$work/src/pnpm-workspace.yaml" 2>/dev/null \
        && fail "pnpm-workspace.yaml already has overrides:; merge them by hand"
      {
        echo "# Added for the AMO sources zip: private packages installed from the tarballs beside this file."
        echo "overrides:"
        jq -r '.[] | "  '"'"'\(.name)'"'"': file:\(.path)"' <<<"$overrides"
      } >>"$work/src/pnpm-workspace.yaml"
    fi
    install="npx --yes $pm install --no-frozen-lockfile"
    build_reviewer="npx --yes $pm ${build_cmd#pnpm }"
    ;;
  *)
    install="npm install"
    build_reviewer="$build_cmd"
    ;;
esac
node_major=$(node -p 'process.versions.node.split(".")[0]')
name=$(jq -r '.name' "$work/src/package.json")
version=$(jq -r '.version' "$work/src/package.json")
cat >"$work/src/AMO-REVIEWER-BUILD.md" <<EOF
# Building $name $version from source

This archive is the complete source of the submitted package. Private packages it depends on are
included as tarballs under \`.wxt/local_modules/\`, so no registry credentials are needed.

Environment: Node.js $node_major or later on any OS (the release build runs on ubuntu-latest with
Node $node_major). The package manager is $pm, fetched by npx, so nothing needs installing globally.

\`\`\`sh
$install
$build_reviewer
\`\`\`

The built extension is in \`$build_out/\`; it is identical, file for file, to the submitted package.
(The release workflow rebuilds it this way and compares before every submission.)
EOF
(cd "$work/src" && rm -f "$sources" && zip -qrX "$sources" .) || fail "could not rewrite $sources"
echo "Sources: $sources rewritten for reviewers ($(jq length <<<"${overrides:-[]}") private packages as local tarballs)"

# 3. Rebuild exactly as the reviewer would.
if [ "${AMO_SKIP_REBUILD:-}" != true ]; then
  mkdir "$work/rebuild"
  unzip -q "$sources" -d "$work/rebuild"
  (
    cd "$work/rebuild"
    export NPM_CONFIG_USERCONFIG=/dev/null npm_config_store_dir="$work/store" CI=true
    eval "$install" >"$work/install.log" 2>&1 || { tail -30 "$work/install.log" >&2; exit 1; }
    eval "$build_reviewer" >"$work/build.log" 2>&1 || { tail -30 "$work/build.log" >&2; exit 1; }
  ) || fail "the sources zip does not build with the reviewer's commands"
  (cd "$work/pkg" && find . -type f | LC_ALL=C sort | xargs shasum -a 256) >"$work/want.txt"
  (cd "$work/rebuild/$build_out" && find . -type f | LC_ALL=C sort | xargs shasum -a 256) >"$work/got.txt"
  diff "$work/want.txt" "$work/got.txt" >&2 || fail "a rebuild from the sources zip differs from $zip; AMO would reject it"
  echo "Rebuild: $(wc -l <"$work/want.txt" | tr -d ' ') files identical to $(basename "$zip")"
fi

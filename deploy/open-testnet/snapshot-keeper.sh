#!/usr/bin/env bash
# Keeps the hosted open TESTNET (no value) state durable on a free host.
# Every INTERVAL seconds: download the sealed snapshot from the gateway and, if
# it is newer and its genesis is the pinned one, publish it as the release asset
# the host restores from on a cold start. A per-genesis copy (state-<hash12>.enc)
# is kept too.
# A snapshot of any other genesis is not uploaded, so a fresh-genesis cold start
# cannot replace state.enc. The pin is EXPECTED_GENESIS in
# .github/workflows/open-testnet-snapshot-keeper.yml on PIN_REF (default main).
# PIN_FILE overrides that read for a local check. ONCE=1 runs a single cycle.
# S2-7: the gateway answers GET /state/snapshot only with the keeper bearer,
# HMAC-SHA256(ZYRON_TESTNET_STATE_SECRET, "zyron-open-testnet-snapshot-keeper-v1")
# as hex (l1/scripts/open-testnet/snapshot-bearer.mjs); anonymous requests get
# 401. Set ZYRON_TESTNET_STATE_SECRET (same value as the gateway's) in the
# environment. Secret handling:
# - the secret and the bearer are never echoed or logged, and never on a command
#   line: node derives the bearer from its own environment and writes it to a
#   0600 header file that curl reads with -H @file;
# - that file lives in a private temp directory (mktemp -d, 0700), removed by a
#   trap on EXIT, INT and TERM;
# - the secret is unset from this shell once the bearer exists, so curl and gh
#   never inherit it;
# - the script fails closed (exit 1, a message without the value) when the
#   secret is missing or empty, node is missing, or the bearer cannot be made.
# Needs: curl, node, gh (authenticated with release write access to the repository).
set -euo pipefail
GATEWAY="${GATEWAY:-https://zyron-open-testnet.onrender.com}"
REPO="${REPO:-zyron249/-zyronchain}"
TAG="${TAG:-open-testnet-state}"
INTERVAL="${INTERVAL:-600}"
PIN_REF="${PIN_REF:-main}"
WORK="${WORK:-$HOME/.zyron-snapshot-keeper}"
mkdir -p "$WORK"; chmod 700 "$WORK"

if [[ -z "${ZYRON_TESTNET_STATE_SECRET:-}" ]]; then
  echo "refusing to start: ZYRON_TESTNET_STATE_SECRET is missing or empty; the gateway serves /state/snapshot only to the keeper bearer" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "refusing to start: node is not installed; it is needed to derive the keeper bearer" >&2
  exit 1
fi
secret_dir=""
sleep_pid=""
cleanup() {
  if [[ -n "$sleep_pid" ]]; then kill "$sleep_pid" 2>/dev/null || true; fi
  if [[ -n "$secret_dir" ]]; then rm -rf -- "$secret_dir"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
secret_dir=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/zyron-keeper-auth.XXXXXXXX")
chmod 700 "$secret_dir"
auth_header="$secret_dir/auth-header"
if ! ( umask 077; node -e 'const { createHmac } = require("node:crypto"); const s = process.env.ZYRON_TESTNET_STATE_SECRET; if (!s) process.exit(2); process.stdout.write(`Authorization: Bearer ${createHmac("sha256", s).update("zyron-open-testnet-snapshot-keeper-v1", "utf8").digest("hex")}\n`);' >"$auth_header" 2>/dev/null ) || [[ ! -s "$auth_header" ]]; then
  echo "refusing to start: could not derive the keeper bearer" >&2
  exit 1
fi
chmod 600 "$auth_header"
unset ZYRON_TESTNET_STATE_SECRET

pinned_genesis() {
  local src pins n
  if [[ -n "${PIN_FILE:-}" ]]; then
    src=$(cat "$PIN_FILE") || return 1
  else
    src=$(gh api -H "Accept: application/vnd.github.raw" "repos/${REPO}/contents/.github/workflows/open-testnet-snapshot-keeper.yml?ref=${PIN_REF}") || return 1
  fi
  pins=$(printf '%s\n' "$src" | sed -nE 's/^[[:space:]]*EXPECTED_GENESIS:[[:space:]]*([0-9a-f]{64})[[:space:]]*$/\1/p')
  n=$(printf '%s\n' "$pins" | grep -c '^[0-9a-f]\{64\}$' || true)
  if [[ "$n" != "1" ]]; then
    echo "refusing to publish: the workflow pin is not exactly one 64-hex EXPECTED_GENESIS" >&2
    return 1
  fi
  printf '%s' "$pins" | tr -d '\n'
}

if ! gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" -R "$REPO" --prerelease --title "Open TESTNET state snapshots (no value)" \
    --notes "Sealed state snapshots of the hosted open TESTNET. Test tokens have no value. Not audited. The files are encrypted; they are only useful to the hosted instance." >/dev/null
fi
last=0
while true; do
  headers="$WORK/h"; body="$WORK/state.enc.part"
  if ! pin=$(pinned_genesis); then
    echo "$(date -Is) refused: pinned genesis unavailable" >&2
  elif curl -fsS --max-time 300 -H "@$auth_header" -D "$headers" -o "$body" "$GATEWAY/state/snapshot"; then
    height=$(tr -d '\r' <"$headers" | awk -F': ' 'tolower($1)=="x-zyron-snapshot-height"{print $2}')
    genesis=$(tr -d '\r' <"$headers" | awk -F': ' 'tolower($1)=="x-zyron-genesis-hash"{print $2}')
    if [[ ! "$genesis" =~ ^[0-9a-f]{64}$ || "$genesis" != "$pin" ]]; then
      echo "$(date -Is) refused: snapshot genesis ${genesis:0:12} is not the pinned genesis ${pin:0:12}" >&2
    elif [[ "$height" =~ ^[0-9]+$ && "$height" -gt "$last" ]]; then
      cp "$body" "$WORK/state.enc"; cp "$body" "$WORK/state-${genesis:0:12}.enc"
      if gh release upload "$TAG" "$WORK/state.enc" "$WORK/state-${genesis:0:12}.enc" -R "$REPO" --clobber >/dev/null; then
        last=$height; echo "$(date -Is) published height $height genesis ${genesis:0:12}"
      else echo "$(date -Is) upload failed" >&2; fi
    else echo "$(date -Is) skipped (height=$height last=$last)"; fi
  else echo "$(date -Is) gateway unreachable" >&2; fi
  if [[ "${ONCE:-}" == "1" ]]; then break; fi
  # Background sleep + wait so INT/TERM run the trap at once, not after the sleep.
  sleep "$INTERVAL" & sleep_pid=$!
  wait "$sleep_pid" || true
  sleep_pid=""
done

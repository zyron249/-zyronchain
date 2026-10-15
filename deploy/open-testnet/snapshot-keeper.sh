#!/usr/bin/env bash
# Keeps the hosted open TESTNET (no value) state durable on a free host.
# Every INTERVAL seconds: download the sealed snapshot from the gateway and, if
# it is newer, publish it as the release asset the host restores from on a cold
# start. A per-genesis copy (state-<hash12>.enc) is kept too, so an accidental
# new genesis never overwrites the previous network's state.
# Needs: curl, gh (authenticated with release write access to the repository).
set -euo pipefail
GATEWAY="${GATEWAY:-https://zyron-open-testnet.onrender.com}"
REPO="${REPO:-zyron249/-zyronchain}"
TAG="${TAG:-open-testnet-state}"
INTERVAL="${INTERVAL:-600}"
WORK="${WORK:-$HOME/.zyron-snapshot-keeper}"
mkdir -p "$WORK"; chmod 700 "$WORK"
if ! gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" -R "$REPO" --prerelease --title "Open TESTNET state snapshots (no value)" \
    --notes "Sealed state snapshots of the hosted open TESTNET. Test tokens have no value. Not audited. The files are encrypted; they are only useful to the hosted instance." >/dev/null
fi
last=0
while true; do
  headers="$WORK/h"; body="$WORK/state.enc.part"
  if curl -fsS --max-time 300 -D "$headers" -o "$body" "$GATEWAY/state/snapshot"; then
    height=$(tr -d '\r' <"$headers" | awk -F': ' 'tolower($1)=="x-zyron-snapshot-height"{print $2}')
    genesis=$(tr -d '\r' <"$headers" | awk -F': ' 'tolower($1)=="x-zyron-genesis-hash"{print $2}')
    if [[ "$height" =~ ^[0-9]+$ && "$genesis" =~ ^[0-9a-f]{64}$ && "$height" -gt "$last" ]]; then
      cp "$body" "$WORK/state.enc"; cp "$body" "$WORK/state-${genesis:0:12}.enc"
      if gh release upload "$TAG" "$WORK/state.enc" "$WORK/state-${genesis:0:12}.enc" -R "$REPO" --clobber >/dev/null; then
        last=$height; echo "$(date -Is) published height $height genesis ${genesis:0:12}"
      else echo "$(date -Is) upload failed" >&2; fi
    else echo "$(date -Is) skipped (height=$height last=$last)"; fi
  else echo "$(date -Is) gateway unreachable" >&2; fi
  sleep "$INTERVAL"
done

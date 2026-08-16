#!/usr/bin/env bash
set -euo pipefail

platform="$(node -p "process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : ''")"
if [ -z "$platform" ]; then
  echo 'unsupported unix miner archive platform' >&2
  exit 1
fi

archive="$(find miner-release -maxdepth 1 -type f -name "ZyronMiner-${platform}-*.tar.gz" | head -n 1)"
if [ -z "$archive" ]; then
  echo 'missing Unix miner archive' >&2
  exit 1
fi

extract="${RUNNER_TEMP:-/tmp}/zyron-miner-unix-archive-smoke"
rm -rf "$extract"
mkdir -p "$extract"
tar -xzf "$archive" -C "$extract"
launcher="$(find "$extract" -maxdepth 2 -type f -name ZyronMiner | head -n 1)"
node_runtime="$(find "$extract" -maxdepth 2 -type f -name node | head -n 1)"
start_here="$(find "$extract" -maxdepth 2 -type f -name START-HERE.txt | head -n 1)"
[ -n "$launcher" ] || { echo 'archive missing ZyronMiner launcher' >&2; exit 1; }
[ -n "$node_runtime" ] || { echo 'archive missing bundled node runtime' >&2; exit 1; }
[ -n "$start_here" ] || { echo 'archive missing START-HERE.txt' >&2; exit 1; }
[ -x "$launcher" ] || { echo 'ZyronMiner launcher is not executable' >&2; exit 1; }
[ -x "$node_runtime" ] || { echo 'bundled node runtime is not executable' >&2; exit 1; }

echo "Unix miner archive smoke: ok ($archive)"

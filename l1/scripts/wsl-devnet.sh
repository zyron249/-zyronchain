#!/usr/bin/env bash
set -euo pipefail
trap 'printf "\nBaslatma durdu. Yukaridaki hata mesajini Codex ile paylasin.\n" >&2' ERR
cd "$HOME"
if ! command -v git >/dev/null || ! command -v curl >/dev/null || ! command -v xz >/dev/null || ! command -v g++ >/dev/null || ! command -v make >/dev/null || ! command -v python3 >/dev/null; then
  if ! command -v apt-get >/dev/null; then
    echo 'Bu dagitimda gerekli araclar eksik ve apt-get yok. Ubuntu veya Debian kullanin: wsl --install -d Ubuntu' >&2
    exit 1
  fi
  echo 'Gerekli Linux araclari kuruluyor. Ubuntu parolaniz istenebilir.'
  sudo apt-get update
  sudo apt-get install -y git curl xz-utils ca-certificates python3 make g++
fi
if ! command -v node >/dev/null || ! command -v npm >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64) node_arch=arm64 ;;
    *) echo 'Desteklenmeyen Linux mimarisi.' >&2; exit 1 ;;
  esac
  mkdir -p "$HOME/.local/share/zyron-runtime"
  task_download=$(mktemp -d "$HOME/.local/share/zyron-runtime/download.XXXXXX")
  curl --fail --location --proto '=https' --tlsv1.2 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$task_download/SHASUMS256.txt"
  node_archive=$(awk -v arch="$node_arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$task_download/SHASUMS256.txt")
  [[ "$node_archive" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]]
  curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/latest-v24.x/$node_archive" -o "$task_download/$node_archive"
  (cd "$task_download"; awk -v name="$node_archive" '$2 == name' SHASUMS256.txt | sha256sum --check -)
  tar -xJf "$task_download/$node_archive" -C "$task_download"
  export PATH="$task_download/${node_archive%.tar.xz}/bin:$PATH"
fi
task_source=$(printf %s "${ZYRON_SOURCE_B64:?Missing repository path}" | base64 --decode)
[[ -d "$task_source/.git" ]] || { echo 'The launcher requires a Git checkout.' >&2; exit 1; }
task_git=(git -c "safe.directory=$task_source" -c core.autocrlf=true -C "$task_source")
[[ -z "$("${task_git[@]}" status --porcelain)" ]] || { echo 'Checkpoint local changes with Git before starting; no files were overwritten.' >&2; exit 1; }
# Archive only committed files into a new Linux directory. Never copy local
# passwords, ignored node_modules, or validator state from the Windows tree.
task_repo=$(mktemp -d "$HOME/zyronchain-devnet.XXXXXX")
"${task_git[@]}" archive HEAD | tar -xf - -C "$task_repo"
echo "Linux working copy: $task_repo"
cd "$task_repo/l1"
node --version
npm ci
echo 'Iki validator baslatiliyor. Transfer dogrulamasi yaklasik 1-2 dakika surer.'
echo 'Bu pencereyi acik tutun. Durdurmak icin Ctrl+C kullanin.'
npm run devnet

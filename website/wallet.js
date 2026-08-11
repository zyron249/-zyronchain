const RELEASE_REF = 'b7e0d37f1471f825f02ac374bafdaf7acb25a990';

const unixScript = `#!/usr/bin/env bash
set -euo pipefail

RELEASE_REF="${RELEASE_REF}"
WORKDIR="${HOME}/zyronchain-wallet-setup"

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 22+ is required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ is required" >&2
  exit 1
fi

if [ -e "$WORKDIR" ]; then
  echo "Refusing to overwrite existing $WORKDIR" >&2
  exit 1
fi

git clone https://github.com/zyron249/-zyronchain.git "$WORKDIR"
git -C "$WORKDIR" checkout --detach "$RELEASE_REF"
cd "$WORKDIR/l1"

npm ci
npm run build

umask 077
printf "Choose wallet password (12+ chars): "
IFS= read -r -s ZYRON_WALLET_PASSWORD
printf "\\n"
if [ "${#ZYRON_WALLET_PASSWORD}" -lt 12 ]; then
  unset ZYRON_WALLET_PASSWORD
  echo "Password must contain at least 12 characters" >&2
  exit 1
fi
printf "%s" "$ZYRON_WALLET_PASSWORD" > wallet.password
unset ZYRON_WALLET_PASSWORD

node dist/src/cli.js keygen --out wallet.json --password-file wallet.password
chmod 600 wallet.json wallet.password

node -e "const fs=require('node:fs');const w=JSON.parse(fs.readFileSync('wallet.json','utf8'));console.log('\\nZyronChain address:',w.address);"
echo "Encrypted keystore: $WORKDIR/l1/wallet.json"
echo "Password file:       $WORKDIR/l1/wallet.password"
echo "Back these files up separately. Never upload either file to a website."
`;

const windowsScript = `$ErrorActionPreference = "Stop"
$ReleaseRef = "${RELEASE_REF}"
$WorkDir = Join-Path $HOME "zyronchain-wallet-setup"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is required" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 22+ is required" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required" }

$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 22) { throw "Node.js 22+ is required" }
if (Test-Path $WorkDir) { throw "Refusing to overwrite existing $WorkDir" }

git clone https://github.com/zyron249/-zyronchain.git $WorkDir
git -C $WorkDir checkout --detach $ReleaseRef
Set-Location (Join-Path $WorkDir "l1")

npm ci
npm run build

$SecurePassword = Read-Host "Choose wallet password (12+ chars)" -AsSecureString
$Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
try {
  $PlainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
  if ($PlainPassword.Length -lt 12) { throw "Password must contain at least 12 characters" }
  [IO.File]::WriteAllText((Join-Path (Get-Location) "wallet.password"), $PlainPassword, (New-Object Text.UTF8Encoding($false)))
} finally {
  if ($Bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr) }
  $PlainPassword = $null
  $SecurePassword = $null
}

node dist/src/cli.js keygen --out wallet.json --password-file wallet.password
icacls wallet.password /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null
icacls wallet.json /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null

$Wallet = Get-Content wallet.json -Raw | ConvertFrom-Json
Write-Host ""
Write-Host "ZyronChain address:" $Wallet.address
Write-Host "Encrypted keystore:" (Join-Path (Get-Location) "wallet.json")
Write-Host "Password file:" (Join-Path (Get-Location) "wallet.password")
Write-Host "Back these files up separately. Never upload either file to a website."
`;

const scripts = {
  unix: {
    code: unixScript,
    label: 'bash',
    filename: 'create-zyron-wallet.sh',
    run: 'Save the script, review it, then run: chmod +x create-zyron-wallet.sh && ./create-zyron-wallet.sh'
  },
  windows: {
    code: windowsScript,
    label: 'PowerShell',
    filename: 'create-zyron-wallet.ps1',
    run: 'Save the script, review it, then run it from PowerShell. If script execution is restricted, use a one-time process-scoped policy rather than changing the machine-wide policy.'
  }
};

let activeOs = 'unix';
const scriptTarget = document.querySelector('[data-wallet-script]');
const scriptLabel = document.querySelector('[data-wallet-script-label]');
const runNote = document.querySelector('[data-wallet-run-note]');
const tabs = [...document.querySelectorAll('[data-wallet-os]')];

function renderScript() {
  const active = scripts[activeOs];
  if (scriptTarget) scriptTarget.textContent = active.code;
  if (scriptLabel) scriptLabel.textContent = active.label;
  if (runNote) runNote.textContent = active.run;
  for (const tab of tabs) {
    const selected = tab.getAttribute('data-wallet-os') === activeOs;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    activeOs = tab.getAttribute('data-wallet-os') === 'windows' ? 'windows' : 'unix';
    renderScript();
  });
}

const copyButton = document.querySelector('[data-wallet-copy]');
if (copyButton) {
  copyButton.addEventListener('click', async () => {
    const original = copyButton.textContent;
    try {
      await navigator.clipboard.writeText(scripts[activeOs].code);
      copyButton.textContent = 'Copied';
    } catch {
      copyButton.textContent = 'Select text';
    }
    window.setTimeout(() => { copyButton.textContent = original || 'Copy'; }, 1500);
  });
}

const downloadButton = document.querySelector('[data-wallet-download]');
if (downloadButton) {
  downloadButton.addEventListener('click', () => {
    const active = scripts[activeOs];
    const blob = new Blob([active.code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = active.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  });
}

const transferButton = document.querySelector('[data-copy-transfer]');
const transferCode = document.querySelector('[data-transfer-code]');
if (transferButton && transferCode) {
  transferButton.addEventListener('click', async () => {
    const original = transferButton.textContent;
    try {
      await navigator.clipboard.writeText(transferCode.textContent.trim());
      transferButton.textContent = 'Copied';
    } catch {
      transferButton.textContent = 'Select text';
    }
    window.setTimeout(() => { transferButton.textContent = original || 'Copy'; }, 1500);
  });
}

for (const target of document.querySelectorAll('[data-wallet-year]')) {
  target.textContent = String(new Date().getFullYear());
}

renderScript();
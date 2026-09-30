const RELEASE_REF = globalThis.ZYRON_RELEASE_REF;
if (typeof RELEASE_REF !== 'string' || !/^[0-9a-f]{40}$/.test(RELEASE_REF)) {
  throw new Error('ZyronChain canonical release reference is unavailable');
}

const core = globalThis.ZyronWalletCore;
if (!core || typeof core.RESTORE_CHECK_JS !== 'string') {
  throw new Error('ZyronChain wallet helpers are unavailable');
}
const RESTORE_JS = core.RESTORE_CHECK_JS;

const unixScript = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '',
  `RELEASE_REF="${RELEASE_REF}"`,
  'WORKDIR="${HOME}/zyronchain-wallet-setup"',
  '',
  'command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }',
  'command -v node >/dev/null 2>&1 || { echo "Node.js 22+ is required" >&2; exit 1; }',
  'command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }',
  '',
  'NODE_MAJOR="$(node -p "process.versions.node.split(\'\.\')[0]")"',
  'if [ "$NODE_MAJOR" -lt 22 ]; then',
  '  echo "Node.js 22+ is required" >&2',
  '  exit 1',
  'fi',
  '',
  'if [ -e "$WORKDIR" ]; then',
  '  echo "Refusing to overwrite existing $WORKDIR" >&2',
  '  exit 1',
  'fi',
  '',
  'git clone https://github.com/zyron249/-zyronchain.git "$WORKDIR"',
  'git -C "$WORKDIR" checkout --detach "$RELEASE_REF"',
  'cd "$WORKDIR/l1"',
  '',
  'npm ci',
  'npm run build',
  '',
  'umask 077',
  'printf "Choose wallet password (12+ chars, a long passphrase is best): "',
  'IFS= read -r -s ZYRON_WALLET_PASSWORD',
  'printf "\\n"',
  'if [ "${#ZYRON_WALLET_PASSWORD}" -lt 12 ]; then',
  '  unset ZYRON_WALLET_PASSWORD',
  '  echo "Password must contain at least 12 characters" >&2',
  '  exit 1',
  'fi',
  'printf "Type the same password again: "',
  'IFS= read -r -s ZYRON_WALLET_PASSWORD_CONFIRM',
  'printf "\\n"',
  'if [ "$ZYRON_WALLET_PASSWORD" != "$ZYRON_WALLET_PASSWORD_CONFIRM" ]; then',
  '  unset ZYRON_WALLET_PASSWORD ZYRON_WALLET_PASSWORD_CONFIRM',
  '  echo "Passwords do not match. Nothing was created." >&2',
  '  exit 1',
  'fi',
  'printf "%s" "$ZYRON_WALLET_PASSWORD" > wallet.password',
  'unset ZYRON_WALLET_PASSWORD ZYRON_WALLET_PASSWORD_CONFIRM',
  '',
  'node dist/src/cli.js keygen --out wallet.json --password-file wallet.password',
  'chmod 600 wallet.json wallet.password',
  '',
  '# Restore test: decrypt locally with the password file and re-derive the address.',
  '# Only the public address is printed; the private key never leaves this process.',
  `node -e "${RESTORE_JS}" wallet.json wallet.password`,
  '',
  'node -e "const fs=require(\'node:fs\');const w=JSON.parse(fs.readFileSync(\'wallet.json\',\'utf8\'));console.log(\'\\nZyronChain address:\',w.address);console.log(\'Grouped to compare:\',[\'ZYN\',...w.address.slice(3).match(/.{4}/g)].join(\' \'));"',
  'if command -v sha256sum >/dev/null 2>&1; then KEYSTORE_SHA256="$(sha256sum wallet.json | cut -d\' \' -f1)"; else KEYSTORE_SHA256="$(shasum -a 256 wallet.json | cut -d\' \' -f1)"; fi',
  'echo "Encrypted keystore: $WORKDIR/l1/wallet.json"',
  'echo "Keystore SHA-256:   $KEYSTORE_SHA256  (write it down; a backup copy must hash to the same value)"',
  'echo "Password file:       $WORKDIR/l1/wallet.password"',
  'echo "Back these files up separately. Never upload either file to a website."',
  'echo "Mining is retired and no public wallet RPC exists yet: balances and transfers are not live."',
  ''
].join('\n');

const windowsScript = [
  '$ErrorActionPreference = "Stop"',
  `$ReleaseRef = "${RELEASE_REF}"`,
  '$WorkDir = Join-Path $HOME "zyronchain-wallet-setup"',
  '',
  'if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is required" }',
  'if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 22+ is required" }',
  'if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required" }',
  '',
  '$NodeMajor = [int]((node -p "process.versions.node.split(\'\.\')[0]").Trim())',
  'if ($NodeMajor -lt 22) { throw "Node.js 22+ is required" }',
  'if (Test-Path $WorkDir) { throw "Refusing to overwrite existing $WorkDir" }',
  '',
  'git clone https://github.com/zyron249/-zyronchain.git $WorkDir',
  'git -C $WorkDir checkout --detach $ReleaseRef',
  'Set-Location (Join-Path $WorkDir "l1")',
  '',
  'npm ci',
  'npm run build',
  '',
  '$SecurePassword = Read-Host "Choose wallet password (12+ chars)" -AsSecureString',
  '$SecureConfirm = Read-Host "Type the same password again" -AsSecureString',
  '$Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)',
  '$BstrConfirm = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureConfirm)',
  'try {',
  '  $PlainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)',
  '  $PlainConfirm = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($BstrConfirm)',
  '  if ($PlainPassword.Length -lt 12) { throw "Password must contain at least 12 characters" }',
  '  if (-not [string]::Equals($PlainPassword, $PlainConfirm, [StringComparison]::Ordinal)) { throw "Passwords do not match. Nothing was created." }',
  '  [IO.File]::WriteAllText((Join-Path (Get-Location) "wallet.password"), $PlainPassword, (New-Object Text.UTF8Encoding($false)))',
  '} finally {',
  '  if ($Bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr) }',
  '  if ($BstrConfirm -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BstrConfirm) }',
  '  $PlainPassword = $null',
  '  $PlainConfirm = $null',
  '  $SecurePassword = $null',
  '  $SecureConfirm = $null',
  '}',
  '',
  'node dist/src/cli.js keygen --out wallet.json --password-file wallet.password',
  'icacls wallet.password /inheritance:r /grant:r "$env:USERNAME:(R,W)" | Out-Null',
  'icacls wallet.json /inheritance:r /grant:r "$env:USERNAME:(R,W)" | Out-Null',
  '',
  '',
  '# Restore test: decrypt locally with the password file and re-derive the address.',
  '# Only the public address is printed; the private key never leaves this process.',
  `$RestoreJs = '${RESTORE_JS.replace(/'/g, "''")}'`,
  'node -e $RestoreJs wallet.json wallet.password',
  'if ($LASTEXITCODE -ne 0) { throw "Restore test failed" }',
  '',
  '$Wallet = Get-Content wallet.json -Raw | ConvertFrom-Json',
  '$Grouped = "ZYN " + (($Wallet.address.Substring(3) -split "(.{4})" | Where-Object { $_ }) -join " ")',
  'Write-Host ""',
  'Write-Host "ZyronChain address:" $Wallet.address',
  'Write-Host "Grouped to compare:" $Grouped',
  'Write-Host "Encrypted keystore:" (Join-Path (Get-Location) "wallet.json")',
  'Write-Host "Keystore SHA-256:" (Get-FileHash wallet.json -Algorithm SHA256).Hash.ToLower() "(write it down; a backup copy must hash to the same value)"',
  'Write-Host "Password file:" (Join-Path (Get-Location) "wallet.password")',
  'Write-Host "Back these files up separately. Never upload either file to a website."',
  'Write-Host "Mining is retired and no public wallet RPC exists yet: balances and transfers are not live."',
  ''
].join('\n');

const unixRestoreScript = [
  '#!/usr/bin/env bash',
  '# Verify (restore-test) a ZyronChain wallet backup on this machine.',
  '# Usage: ./verify-zyron-wallet.sh /path/to/wallet.json /path/to/wallet.password',
  'set -euo pipefail',
  '',
  `RELEASE_REF="${RELEASE_REF}"`,
  'WORKDIR="${HOME}/zyronchain-wallet-verify"',
  '',
  'if [ "$#" -ne 2 ]; then echo "Usage: $0 <wallet.json> <wallet.password>" >&2; exit 2; fi',
  'for f in "$1" "$2"; do [ -f "$f" ] || { echo "Not a file: $f" >&2; exit 1; }; done',
  'KEYSTORE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"',
  'PASSWORD_FILE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"',
  '',
  'command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }',
  'command -v node >/dev/null 2>&1 || { echo "Node.js 22+ is required" >&2; exit 1; }',
  'command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }',
  '',
  'if [ ! -d "$WORKDIR" ]; then',
  '  git clone https://github.com/zyron249/-zyronchain.git "$WORKDIR"',
  'fi',
  'git -C "$WORKDIR" fetch --quiet origin',
  'git -C "$WORKDIR" checkout --detach "$RELEASE_REF"',
  'cd "$WORKDIR/l1"',
  'npm ci',
  'npm run build',
  '',
  '# Decrypts locally and re-derives the address. Prints only the public address.',
  `node -e "${RESTORE_JS}" "$KEYSTORE" "$PASSWORD_FILE"`,
  'if command -v sha256sum >/dev/null 2>&1; then sha256sum "$KEYSTORE"; else shasum -a 256 "$KEYSTORE"; fi',
  'echo "Compare the SHA-256 above with the value recorded when the wallet was created."',
  ''
].join('\n');

const windowsRestoreScript = [
  '# Verify (restore-test) a ZyronChain wallet backup on this machine.',
  '# Usage: .\\verify-zyron-wallet.ps1 C:\\path\\wallet.json C:\\path\\wallet.password',
  'param([Parameter(Mandatory = $true)][string]$Keystore, [Parameter(Mandatory = $true)][string]$PasswordFile)',
  '$ErrorActionPreference = "Stop"',
  `$ReleaseRef = "${RELEASE_REF}"`,
  '$WorkDir = Join-Path $HOME "zyronchain-wallet-verify"',
  '$KeystorePath = (Resolve-Path -LiteralPath $Keystore).Path',
  '$PasswordPath = (Resolve-Path -LiteralPath $PasswordFile).Path',
  '',
  'if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is required" }',
  'if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 22+ is required" }',
  'if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required" }',
  '',
  'if (-not (Test-Path $WorkDir)) { git clone https://github.com/zyron249/-zyronchain.git $WorkDir }',
  'git -C $WorkDir fetch --quiet origin',
  'git -C $WorkDir checkout --detach $ReleaseRef',
  'Set-Location (Join-Path $WorkDir "l1")',
  'npm ci',
  'npm run build',
  '',
  '# Decrypts locally and re-derives the address. Prints only the public address.',
  `$RestoreJs = '${RESTORE_JS.replace(/'/g, "''")}'`,
  'node -e $RestoreJs $KeystorePath $PasswordPath',
  'if ($LASTEXITCODE -ne 0) { throw "Restore test failed" }',
  'Write-Host "Keystore SHA-256:" (Get-FileHash -LiteralPath $KeystorePath -Algorithm SHA256).Hash.ToLower()',
  'Write-Host "Compare the SHA-256 above with the value recorded when the wallet was created."',
  ''
].join('\n');

const scripts = {
  create: {
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
  },
  restore: {
    unix: {
      code: unixRestoreScript,
      label: 'bash',
      filename: 'verify-zyron-wallet.sh',
      run: 'Run it against your BACKUP copies, e.g.: chmod +x verify-zyron-wallet.sh && ./verify-zyron-wallet.sh /media/usb/wallet.json /other/place/wallet.password'
    },
    windows: {
      code: windowsRestoreScript,
      label: 'PowerShell',
      filename: 'verify-zyron-wallet.ps1',
      run: 'Run it against your BACKUP copies, e.g.: .\\verify-zyron-wallet.ps1 E:\\wallet.json F:\\wallet.password (use a one-time process-scoped execution policy if needed).'
    }
  }
};

let activeOs = 'unix';
let activeMode = 'create';
const scriptTarget = document.querySelector('[data-wallet-script]');
const scriptLabel = document.querySelector('[data-wallet-script-label]');
const runNote = document.querySelector('[data-wallet-run-note]');
const tabs = [...document.querySelectorAll('[data-wallet-os]')];
const modeTabs = [...document.querySelectorAll('[data-wallet-mode]')];

function activeScript() {
  return scripts[activeMode][activeOs];
}

function syncTabs(list, attribute, value) {
  for (const tab of list) {
    const selected = tab.getAttribute(attribute) === value;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
}

function renderScript() {
  const active = activeScript();
  if (scriptTarget) scriptTarget.textContent = active.code;
  if (scriptLabel) scriptLabel.textContent = `${active.label} · ${active.filename}`;
  if (runNote) runNote.textContent = active.run;
  syncTabs(tabs, 'data-wallet-os', activeOs);
  syncTabs(modeTabs, 'data-wallet-mode', activeMode);
}

for (const target of document.querySelectorAll('[data-release-short]')) {
  target.textContent = RELEASE_REF.slice(0, 12);
  target.setAttribute('title', RELEASE_REF);
}

function wireTabs(list, onSelect) {
  for (const tab of list) {
    tab.addEventListener('click', () => {
      onSelect(tab);
      renderScript();
    });
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const index = list.indexOf(tab);
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      const next = list[(index + offset + list.length) % list.length];
      next?.click();
      next?.focus();
    });
  }
}

wireTabs(tabs, (tab) => {
  activeOs = tab.getAttribute('data-wallet-os') === 'windows' ? 'windows' : 'unix';
});
wireTabs(modeTabs, (tab) => {
  activeMode = tab.getAttribute('data-wallet-mode') === 'restore' ? 'restore' : 'create';
});

// Clipboard is only ever used for public text (scripts, templates, addresses).
async function copyPublicText(button, text) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Select text';
  }
  window.setTimeout(() => { button.textContent = original || 'Copy'; }, 1500);
}

const copyButton = document.querySelector('[data-wallet-copy]');
if (copyButton) {
  copyButton.addEventListener('click', () => copyPublicText(copyButton, activeScript().code));
}

const downloadButton = document.querySelector('[data-wallet-download]');
if (downloadButton) {
  downloadButton.addEventListener('click', () => {
    const active = activeScript();
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

// ---- Address checker (public data only; nothing leaves the page) ----
const addressInput = document.querySelector('[data-address-input]');
const publicKeyInput = document.querySelector('[data-pubkey-input]');
const addressResult = document.querySelector('[data-address-result]');
const addressGrouped = document.querySelector('[data-address-grouped]');
const addressCopy = document.querySelector('[data-address-copy]');
let checkedAddress = '';
let checkSequence = 0;

function setResult(element, state, message) {
  if (!element) return;
  element.dataset.state = state;
  element.textContent = message;
}

async function checkAddress() {
  const sequence = ++checkSequence;
  const address = addressInput ? addressInput.value : '';
  const publicKey = publicKeyInput ? publicKeyInput.value.trim() : '';
  checkedAddress = '';
  if (addressCopy) addressCopy.disabled = true;
  if (addressGrouped) addressGrouped.textContent = '';
  if (!address && !publicKey) {
    setResult(addressResult, 'idle', 'Paste a ZYN address, a public key, or both.');
    return;
  }
  let derived = '';
  if (publicKey) {
    try {
      derived = await core.addressFromPublicKey(publicKey);
    } catch (error) {
      if (sequence === checkSequence) setResult(addressResult, 'bad', error.message);
      return;
    }
  }
  if (sequence !== checkSequence) return;
  if (address) {
    const problem = core.explainAddress(address);
    if (problem) {
      setResult(addressResult, 'bad', `Not a valid ZyronChain address. ${problem}`);
      return;
    }
    if (derived && derived !== address) {
      setResult(addressResult, 'bad', `Mismatch: this public key derives ${derived}, not the address you entered. Do not use it.`);
      return;
    }
  }
  checkedAddress = address || derived;
  if (addressGrouped) addressGrouped.textContent = core.groupAddress(checkedAddress);
  if (addressCopy) addressCopy.disabled = false;
  const message = derived && address
    ? 'Match: the public key derives exactly this address (same rule as the L1).'
    : derived
      ? 'Derived with the L1 rule: ZYN + first 40 hex of SHA-256(public key).'
      : 'Well-formed ZyronChain address. The format has no checksum, so compare every group with the source.';
  setResult(addressResult, 'ok', message);
}

for (const input of [addressInput, publicKeyInput]) {
  input?.addEventListener('input', () => { void checkAddress(); });
}
if (addressCopy) {
  addressCopy.addEventListener('click', () => {
    if (checkedAddress) void copyPublicText(addressCopy, checkedAddress);
  });
}

// ---- Transfer template builder (placeholders for RPC + chain ID stay until published) ----
const transferCode = document.querySelector('[data-transfer-code]');
const transferTo = document.querySelector('[data-transfer-to]');
const transferAmount = document.querySelector('[data-transfer-amount]');
const transferFee = document.querySelector('[data-transfer-fee]');
const transferResult = document.querySelector('[data-transfer-result]');
const transferDefault = transferCode ? transferCode.textContent : '';

function renderTransfer() {
  if (!transferCode) return;
  const receiver = transferTo ? transferTo.value.trim() : '';
  const amountZyn = transferAmount ? transferAmount.value : '';
  const feeAtoms = transferFee ? transferFee.value : '';
  if (!receiver && !amountZyn) {
    transferCode.textContent = transferDefault;
    setResult(transferResult, 'idle', 'Fill in receiver and amount to build the command. Nothing is sent.');
    return;
  }
  try {
    transferCode.textContent = core.buildTransferCommand({ receiver, amountZyn, feeAtoms });
    const atoms = core.zynToAtoms(amountZyn);
    setResult(transferResult, 'ok', `${core.atomsToZyn(atoms)} ZYN = ${atoms} atoms (1 ZYN = 100,000,000 atoms). Template only: it cannot run until a public RPC and chain ID are published.`);
  } catch (error) {
    transferCode.textContent = transferDefault;
    const message = receiver && !core.isValidAddress(receiver)
      ? `Receiver: ${core.explainAddress(receiver)}`
      : error.message;
    setResult(transferResult, 'bad', message);
  }
}

for (const input of [transferTo, transferAmount, transferFee]) {
  input?.addEventListener('input', renderTransfer);
}

const transferButton = document.querySelector('[data-copy-transfer]');
if (transferButton && transferCode) {
  transferButton.addEventListener('click', () => copyPublicText(transferButton, transferCode.textContent.trim()));
}

for (const target of document.querySelectorAll('[data-wallet-year]')) {
  target.textContent = String(new Date().getFullYear());
}

renderScript();

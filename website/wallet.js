const RELEASE_REF = globalThis.ZYRON_RELEASE_REF;
if (typeof RELEASE_REF !== 'string' || !/^[0-9a-f]{40}$/.test(RELEASE_REF)) {
  throw new Error('ZyronChain canonical release reference is unavailable');
}

// Defense in depth against clickjacking until frame-ancestors/X-Frame-Options are served as
// HTTP headers: refuse to render the wallet page inside a frame.
if (globalThis.top !== globalThis.self && globalThis.document) {
  document.documentElement.style.display = 'none';
  throw new Error('ZyronChain wallet page refuses to render inside a frame');
}

const core = globalThis.ZyronWalletCore;
if (!core || typeof core.RESTORE_CHECK_JS !== 'string') {
  throw new Error('ZyronChain wallet helpers are unavailable');
}
const RESTORE_JS = core.RESTORE_CHECK_JS;
const PASSWORD_CHECK_JS = core.PASSWORD_CHECK_JS;
// Prints the address, its display-only checksum form and 4-character groups (public data only).
const ADDRESS_PRINT_JS = [
  "const fs=require('node:fs');const c=require('node:crypto');",
  "const a=JSON.parse(fs.readFileSync(process.argv[1],'utf8')).address;",
  `const h=c.createHash('sha256').update('${core.ADDRESS_CHECKSUM_DOMAIN}'+a).digest('hex');`,
  "let o='ZYN';for(let i=0;i<40;i++){const ch=a[i+3];o+=(ch>='a'&&ch<='f'&&parseInt(h[i],16)>=8)?ch.toUpperCase():ch;}",
  "console.log('ZyronChain address:         '+a);",
  "console.log('Checksummed (display only): '+o);",
  "console.log('Grouped to compare:         '+['ZYN',...o.slice(3).match(/.{4}/g)].join(' '));"
].join('');
const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;

// Shared bash: the password lives only in shell memory and, for the few seconds the CLI needs it,
// in a 0600 file inside a private temp directory (RAM-backed /dev/shm when available) that is
// shredded/removed on exit, including on errors and Ctrl+C.
const unixSecretHelpers = [
  'SECRET_DIR=""',
  'cleanup_secret() {',
  '  if [ -n "$SECRET_DIR" ] && [ -d "$SECRET_DIR" ]; then',
  '    if [ -f "$SECRET_DIR/wallet.password" ]; then',
  '      if command -v shred >/dev/null 2>&1; then shred -u "$SECRET_DIR/wallet.password"; else rm -f "$SECRET_DIR/wallet.password"; fi',
  '    fi',
  '    rmdir "$SECRET_DIR" 2>/dev/null || true',
  '  fi',
  '  SECRET_DIR=""',
  '}',
  'trap cleanup_secret EXIT',
  "trap 'exit 130' INT TERM",
  'make_password_file() {',
  '  if [ -d /dev/shm ] && [ -w /dev/shm ]; then SECRET_DIR="$(mktemp -d /dev/shm/zyron-wallet.XXXXXX)"; else SECRET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zyron-wallet.XXXXXX")"; fi',
  '  chmod 700 "$SECRET_DIR"',
  '  PASSWORD_FILE="$SECRET_DIR/wallet.password"',
  '  (umask 077; printf "%s" "$WALLET_PASSWORD" > "$PASSWORD_FILE")',
  '  unset WALLET_PASSWORD',
  '}',
  'read_env_password() {',
  '  if [ -n "${ZYRON_WALLET_PASSWORD:-}" ]; then',
  '    echo "WARNING: using ZYRON_WALLET_PASSWORD from the environment (automation only)." >&2',
  '    echo "         Environment variables can leak to other processes of this user, shell history and CI logs. Unset it afterwards." >&2',
  '    WALLET_PASSWORD="$ZYRON_WALLET_PASSWORD"',
  '    return 0',
  '  fi',
  '  return 1',
  '}'
];

const unixScript = [
  '#!/usr/bin/env bash',
  '# Create a ZyronChain wallet locally. No password file is left on disk.',
  '# Automation only: export ZYRON_WALLET_PASSWORD to skip the prompt (see the warning it prints).',
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
  ...unixSecretHelpers,
  '',
  'if ! read_env_password; then',
  '  printf "Choose wallet password (12+ chars, a long passphrase is best): "',
  '  IFS= read -r -s WALLET_PASSWORD',
  '  printf "\\n"',
  '  printf "Type the same password again: "',
  '  IFS= read -r -s WALLET_PASSWORD_CONFIRM',
  '  printf "\\n"',
  '  if [ "$WALLET_PASSWORD" != "$WALLET_PASSWORD_CONFIRM" ]; then',
  '    unset WALLET_PASSWORD WALLET_PASSWORD_CONFIRM',
  '    echo "Passwords do not match. Nothing was created." >&2',
  '    exit 1',
  '  fi',
  '  unset WALLET_PASSWORD_CONFIRM',
  'fi',
  '',
  '# Strength check (length, repetition, ~60-bit estimate). The password goes through stdin, never argv.',
  `printf "%s" "$WALLET_PASSWORD" | node -e "${PASSWORD_CHECK_JS}"`,
  '',
  'make_password_file',
  'node dist/src/cli.js keygen --out wallet.json --password-file "$PASSWORD_FILE"',
  'chmod 600 wallet.json',
  '',
  '# Restore test: decrypt locally and re-derive the address. Only the public address is printed.',
  `node -e "${RESTORE_JS}" wallet.json "$PASSWORD_FILE"`,
  'cleanup_secret',
  '',
  `node -e "${ADDRESS_PRINT_JS}" wallet.json`,
  'if command -v sha256sum >/dev/null 2>&1; then KEYSTORE_SHA256="$(sha256sum wallet.json | cut -d\' \' -f1)"; else KEYSTORE_SHA256="$(shasum -a 256 wallet.json | cut -d\' \' -f1)"; fi',
  'echo "Encrypted keystore: $WORKDIR/l1/wallet.json"',
  'echo "Keystore SHA-256:   $KEYSTORE_SHA256  (write it down; a backup copy must hash to the same value)"',
  'echo "No password file was kept. Remember the password or store it offline, separate from the keystore."',
  'echo "Mining is retired and no public wallet RPC exists yet: balances and transfers are not live."',
  ''
].join('\n');

const windowsSecretHelpers = [
  'function Get-EnvWalletPassword {',
  '  if ($env:ZYRON_WALLET_PASSWORD) {',
  '    Write-Warning "Using ZYRON_WALLET_PASSWORD from the environment (automation only). Environment variables can leak to other processes of this user, shell history and CI logs. Remove it afterwards."',
  '    return $env:ZYRON_WALLET_PASSWORD',
  '  }',
  '  return $null',
  '}',
  'function New-PasswordFile([string]$Plain) {',
  '  $dir = Join-Path ([IO.Path]::GetTempPath()) ("zyron-wallet-" + [guid]::NewGuid().ToString("N"))',
  '  New-Item -ItemType Directory -Path $dir | Out-Null',
  '  icacls $dir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null',
  '  $file = Join-Path $dir "wallet.password"',
  '  [IO.File]::WriteAllText($file, $Plain, (New-Object Text.UTF8Encoding($false)))',
  '  return $file',
  '}',
  'function Remove-PasswordFile([string]$File) {',
  '  if ($File -and (Test-Path -LiteralPath $File)) {',
  '    [IO.File]::WriteAllBytes($File, (New-Object byte[] 1024))',
  '    Remove-Item -LiteralPath $File -Force',
  '    Remove-Item -LiteralPath (Split-Path -Parent $File) -Force -Recurse -ErrorAction SilentlyContinue',
  '  }',
  '}',
  'function Read-PlainSecure([string]$Prompt) {',
  '  $secure = Read-Host $Prompt -AsSecureString',
  '  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
  '  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }',
  '  finally { if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } }',
  '}'
];

const windowsScript = [
  '# Create a ZyronChain wallet locally. No password file is left on disk.',
  '# Automation only: set $env:ZYRON_WALLET_PASSWORD to skip the prompt (see the warning it prints).',
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
  ...windowsSecretHelpers,
  `$PasswordCheckJs = ${psQuote(PASSWORD_CHECK_JS)}`,
  `$RestoreJs = ${psQuote(RESTORE_JS)}`,
  `$AddressPrintJs = ${psQuote(ADDRESS_PRINT_JS)}`,
  '',
  '$PlainPassword = Get-EnvWalletPassword',
  'if (-not $PlainPassword) {',
  '  $PlainPassword = Read-PlainSecure "Choose wallet password (12+ chars)"',
  '  $PlainConfirm = Read-PlainSecure "Type the same password again"',
  '  if (-not [string]::Equals($PlainPassword, $PlainConfirm, [StringComparison]::Ordinal)) { $PlainPassword = $null; $PlainConfirm = $null; throw "Passwords do not match. Nothing was created." }',
  '  $PlainConfirm = $null',
  '}',
  '# Strength check (length, repetition, ~60-bit estimate). The password goes through stdin, never argv.',
  '$PlainPassword | node -e $PasswordCheckJs',
  'if ($LASTEXITCODE -ne 0) { $PlainPassword = $null; throw "Password rejected by the strength check. Nothing was created." }',
  '',
  '$PasswordFile = $null',
  'try {',
  '  $PasswordFile = New-PasswordFile $PlainPassword',
  '  $PlainPassword = $null',
  '  node dist/src/cli.js keygen --out wallet.json --password-file $PasswordFile',
  '  if ($LASTEXITCODE -ne 0) { throw "keygen failed" }',
  '  icacls wallet.json /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null',
  '  # Restore test: decrypt locally and re-derive the address. Only the public address is printed.',
  '  node -e $RestoreJs wallet.json $PasswordFile',
  '  if ($LASTEXITCODE -ne 0) { throw "Restore test failed" }',
  '} finally {',
  '  Remove-PasswordFile $PasswordFile',
  '  $PlainPassword = $null',
  '}',
  '',
  'node -e $AddressPrintJs wallet.json',
  'Write-Host "Encrypted keystore:" (Join-Path (Get-Location) "wallet.json")',
  'Write-Host "Keystore SHA-256:" (Get-FileHash wallet.json -Algorithm SHA256).Hash.ToLower() "(write it down; a backup copy must hash to the same value)"',
  'Write-Host "No password file was kept. Remember the password or store it offline, separate from the keystore."',
  'Write-Host "Mining is retired and no public wallet RPC exists yet: balances and transfers are not live."',
  ''
].join('\n');

const unixRestoreScript = [
  '#!/usr/bin/env bash',
  '# Verify (restore-test) a ZyronChain wallet backup on this machine.',
  '# Usage: ./verify-zyron-wallet.sh /path/to/wallet.json [/path/to/password-file]',
  '# Without a password file it asks for the password (or reads ZYRON_WALLET_PASSWORD, automation only).',
  'set -euo pipefail',
  '',
  `RELEASE_REF="${RELEASE_REF}"`,
  'WORKDIR="${HOME}/zyronchain-wallet-verify"',
  '',
  'if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then echo "Usage: $0 <wallet.json> [password-file]" >&2; exit 2; fi',
  '[ -f "$1" ] || { echo "Not a file: $1" >&2; exit 1; }',
  'KEYSTORE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"',
  'GIVEN_PASSWORD_FILE=""',
  'if [ "$#" -eq 2 ]; then [ -f "$2" ] || { echo "Not a file: $2" >&2; exit 1; }; GIVEN_PASSWORD_FILE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; fi',
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
  'umask 077',
  ...unixSecretHelpers,
  '',
  'if [ -n "$GIVEN_PASSWORD_FILE" ]; then',
  '  PASSWORD_FILE="$GIVEN_PASSWORD_FILE"',
  'else',
  '  if ! read_env_password; then',
  '    printf "Wallet password: "',
  '    IFS= read -r -s WALLET_PASSWORD',
  '    printf "\\n"',
  '  fi',
  '  make_password_file',
  'fi',
  '',
  '# Decrypts locally and re-derives the address. Prints only the public address.',
  `node -e "${RESTORE_JS}" "$KEYSTORE" "$PASSWORD_FILE"`,
  'cleanup_secret',
  `node -e "${ADDRESS_PRINT_JS}" "$KEYSTORE"`,
  'if command -v sha256sum >/dev/null 2>&1; then sha256sum "$KEYSTORE"; else shasum -a 256 "$KEYSTORE"; fi',
  'echo "Compare the SHA-256 above with the value recorded when the wallet was created."',
  ''
].join('\n');

const windowsRestoreScript = [
  '# Verify (restore-test) a ZyronChain wallet backup on this machine.',
  '# Usage: .\\verify-zyron-wallet.ps1 C:\\path\\wallet.json [C:\\path\\password-file]',
  '# Without a password file it asks for the password (or reads $env:ZYRON_WALLET_PASSWORD, automation only).',
  'param([Parameter(Mandatory = $true)][string]$Keystore, [string]$PasswordFile)',
  '$ErrorActionPreference = "Stop"',
  `$ReleaseRef = "${RELEASE_REF}"`,
  '$WorkDir = Join-Path $HOME "zyronchain-wallet-verify"',
  '$KeystorePath = (Resolve-Path -LiteralPath $Keystore).Path',
  '$GivenPasswordPath = if ($PasswordFile) { (Resolve-Path -LiteralPath $PasswordFile).Path } else { $null }',
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
  ...windowsSecretHelpers,
  `$RestoreJs = ${psQuote(RESTORE_JS)}`,
  `$AddressPrintJs = ${psQuote(ADDRESS_PRINT_JS)}`,
  '',
  '$TempPasswordFile = $null',
  'try {',
  '  if ($GivenPasswordPath) { $UsePasswordFile = $GivenPasswordPath } else {',
  '    $PlainPassword = Get-EnvWalletPassword',
  '    if (-not $PlainPassword) { $PlainPassword = Read-PlainSecure "Wallet password" }',
  '    $TempPasswordFile = New-PasswordFile $PlainPassword',
  '    $PlainPassword = $null',
  '    $UsePasswordFile = $TempPasswordFile',
  '  }',
  '  # Decrypts locally and re-derives the address. Prints only the public address.',
  '  node -e $RestoreJs $KeystorePath $UsePasswordFile',
  '  if ($LASTEXITCODE -ne 0) { throw "Restore test failed" }',
  '} finally {',
  '  Remove-PasswordFile $TempPasswordFile',
  '  $PlainPassword = $null',
  '}',
  'node -e $AddressPrintJs $KeystorePath',
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
      run: 'Run it against your BACKUP copy; it asks for the password: chmod +x verify-zyron-wallet.sh && ./verify-zyron-wallet.sh /media/usb/wallet.json'
    },
    windows: {
      code: windowsRestoreScript,
      label: 'PowerShell',
      filename: 'verify-zyron-wallet.ps1',
      run: 'Run it against your BACKUP copy; it asks for the password: .\\verify-zyron-wallet.ps1 E:\\wallet.json (use a one-time process-scoped execution policy if needed).'
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
const addressCopyPlain = document.querySelector('[data-address-copy-plain]');
let checked = null;
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
  checked = null;
  for (const button of [addressCopy, addressCopyPlain]) if (button) button.disabled = true;
  if (addressGrouped) addressGrouped.textContent = '';
  if (!address && !publicKey) {
    setResult(addressResult, 'idle', 'Paste a ZYN address (plain or checksummed), a public key, or both.');
    return;
  }
  try {
    const derived = publicKey ? await core.addressFromPublicKey(publicKey) : '';
    const parsed = address ? await core.parseAddressInput(address) : null;
    if (sequence !== checkSequence) return;
    if (parsed && derived && parsed.canonical !== derived) {
      setResult(addressResult, 'bad', `Mismatch: this public key derives ${derived}, not the address you entered. Do not use it.`);
      return;
    }
    const canonical = parsed ? parsed.canonical : derived;
    const checksummed = parsed ? parsed.checksummed : await core.toChecksumAddress(derived);
    if (sequence !== checkSequence) return;
    checked = { canonical, checksummed };
    if (addressGrouped) addressGrouped.textContent = ['ZYN', ...checksummed.slice(3).match(/.{4}/g)].join(' ');
    for (const button of [addressCopy, addressCopyPlain]) if (button) button.disabled = false;
    let message;
    if (parsed && derived) message = 'Match: the public key derives exactly this address (same rule as the L1).';
    else if (derived) message = 'Derived with the L1 rule: ZYN + first 40 hex of SHA-256(public key).';
    else if (parsed.checksumVerified) message = 'Checksum verified: the upper/lower-case pattern matches, so a typo is very unlikely.';
    else message = 'Well-formed plain address (no checksum in it). Shown below in checksummed form; compare every group with the source or ask for the checksummed form.';
    setResult(addressResult, 'ok', message);
  } catch (error) {
    if (sequence === checkSequence) setResult(addressResult, 'bad', `Not usable: ${error.message}`);
  }
}

for (const input of [addressInput, publicKeyInput]) {
  input?.addEventListener('input', () => { void checkAddress(); });
}
addressCopy?.addEventListener('click', () => { if (checked) void copyPublicText(addressCopy, checked.checksummed); });
addressCopyPlain?.addEventListener('click', () => { if (checked) void copyPublicText(addressCopyPlain, checked.canonical); });

// ---- Transfer template builder (placeholders for RPC + chain ID stay until published) ----
const transferCode = document.querySelector('[data-transfer-code]');
const transferTo = document.querySelector('[data-transfer-to]');
const transferAmount = document.querySelector('[data-transfer-amount]');
const transferFee = document.querySelector('[data-transfer-fee]');
const transferResult = document.querySelector('[data-transfer-result]');
const transferDefault = transferCode ? transferCode.textContent : '';
let transferSequence = 0;

async function renderTransfer() {
  if (!transferCode) return;
  const sequence = ++transferSequence;
  const receiverInput = transferTo ? transferTo.value.trim() : '';
  const amountZyn = transferAmount ? transferAmount.value : '';
  const feeAtoms = transferFee ? transferFee.value : '';
  if (!receiverInput && !amountZyn) {
    transferCode.textContent = transferDefault;
    setResult(transferResult, 'idle', 'Fill in receiver and amount to build the command. Nothing is sent.');
    return;
  }
  try {
    let parsed;
    try {
      parsed = await core.parseAddressInput(receiverInput);
    } catch (error) {
      throw new Error(`Receiver: ${error.message}`);
    }
    if (sequence !== transferSequence) return;
    // The command carries the canonical lower-case address (what consensus signs and stores).
    transferCode.textContent = core.buildTransferCommand({ receiver: parsed.canonical, amountZyn, feeAtoms });
    const atoms = core.zynToAtoms(amountZyn);
    const check = parsed.checksumVerified ? 'Receiver checksum verified. ' : 'Receiver has no checksum; double-check it. ';
    setResult(transferResult, 'ok', `${check}${core.atomsToZyn(atoms)} ZYN = ${atoms} atoms (1 ZYN = 100,000,000 atoms). Template only: it cannot run until a public RPC and chain ID are published.`);
  } catch (error) {
    if (sequence !== transferSequence) return;
    transferCode.textContent = transferDefault;
    setResult(transferResult, 'bad', error.message);
  }
}

for (const input of [transferTo, transferAmount, transferFee]) {
  input?.addEventListener('input', () => { void renderTransfer(); });
}

const transferButton = document.querySelector('[data-copy-transfer]');
if (transferButton && transferCode) {
  transferButton.addEventListener('click', () => copyPublicText(transferButton, transferCode.textContent.trim()));
}

for (const target of document.querySelectorAll('[data-wallet-year]')) {
  target.textContent = String(new Date().getFullYear());
}

renderScript();

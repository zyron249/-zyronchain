/*
 * Read-only wallet testnet page. It looks up public account data and submits a
 * signed transfer the owner already produced. It never asks for a recovery
 * phrase, a password or a private key, and it does not sign anything.
 */
(() => {
  'use strict';

  const RPC = 'https://zyron-wallet-testnet-rpc.onrender.com';
  const COLD_START_MS = 60000;
  const ATTEMPT_MS = 20000;
  const WAKE_TOTAL_MS = 120000;
  const RETRY_DELAY_MS = 4000;
  const POLL_MS = 3000;
  const POLL_TIMEOUT_MS = 90000;
  const ATOMS_PER_ZYN = 100000000;
  const ADDRESS_DOMAIN = 'zyronchain/address-checksum/v1:';
  const CANONICAL_RE = /^ZYN[0-9a-f]{40}$/;
  const INPUT_RE = /^ZYN[0-9a-fA-F]{40}$/;
  const HEX_RE = /^[0-9a-f]+$/;
  const TRANSFER_KEYS = ['amountAtoms', 'chainId', 'feeAtoms', 'kind', 'nonce', 'publicKey', 'receiver', 'sender', 'signature', 'timestampMs', 'txid', 'version'];

  const $ = (sel) => document.querySelector(sel);
  const text = (sel, value) => { const el = $(sel); if (el) el.textContent = value; };
  const msg = (sel, value, kind) => {
    const el = $(sel);
    if (!el) return;
    el.textContent = value;
    el.className = 'msg' + (kind ? ' ' + kind : '');
  };

  let status = null;
  let reviewed = null;

  function unknown(value) { return value == null || value === '' ? 'unknown' : String(value); }
  function whole(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unknown'; }
  function formatZyn(atoms) {
    if (!Number.isSafeInteger(atoms) || atoms < 0) return 'unknown';
    const unit = Math.floor(atoms / ATOMS_PER_ZYN);
    const fraction = String(atoms % ATOMS_PER_ZYN).padStart(8, '0').replace(/0+$/, '');
    return (fraction ? unit + '.' + fraction : String(unit)) + ' ZYN';
  }
  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  async function toChecksumAddress(address) {
    if (!CANONICAL_RE.test(address)) throw new Error('Address must be canonical: ZYN + 40 lower-case hex');
    const hash = await sha256Hex(ADDRESS_DOMAIN + address);
    let out = 'ZYN';
    const body = address.slice(3);
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index];
      out += char >= 'a' && char <= 'f' && parseInt(hash[index], 16) >= 8 ? char.toUpperCase() : char;
    }
    return out;
  }
  async function parseAddress(input) {
    const value = String(input == null ? '' : input).trim();
    if (!INPUT_RE.test(value)) throw new Error('Invalid address: expected ZYN followed by 40 hex characters');
    const canonical = 'ZYN' + value.slice(3).toLowerCase();
    const checksummed = await toChecksumAddress(canonical);
    if (value === canonical) return { canonical, checksummed, checksumVerified: false };
    if (value !== checksummed) throw new Error('Address checksum mismatch: the mixed-case letters do not match (likely a typo)');
    return { canonical, checksummed, checksumVerified: true };
  }
  function looksLikePhrase(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return false;
    if (!trimmed.startsWith('{') && /private\s*key|recovery phrase|seed phrase|mnemonic|secret phrase/i.test(trimmed)) return true;
    const words = trimmed.split(/\s+/);
    return words.length >= 12 && words.length <= 24 && words.every((word) => /^[a-z]+$/i.test(word));
  }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function request(path, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (options && options.timeoutMs) || COLD_START_MS);
    try {
      const response = await fetch(RPC + path, {
        method: options && options.method || 'GET',
        headers: { accept: 'application/json', ...(options && options.body ? { 'content-type': 'application/json' } : {}) },
        body: options && options.body,
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      });
      let body = null;
      try { body = await response.json(); } catch (_) { body = null; }
      if (!response.ok) {
        const error = new Error(body && typeof body.error === 'string' ? body.error : 'The wallet testnet did not accept this request');
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('The free host is still waking up. Wait a moment and try again.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // A sleeping free host answers slowly, with a gateway error, or while it restores saved state.
  // GET requests are retried with a per-attempt timeout until WAKE_TOTAL_MS, then a clear message is shown.
  function isWaking(error) {
    if (!error) return false;
    if (error.name === 'AbortError' || error.name === 'TypeError') return true;
    if (error.status === 502 || error.status === 503 || error.status === 504) return true;
    return /restor|starting|waking|not ready/i.test(String(error.message || ''));
  }
  async function getWithRetry(path, onWait) {
    const started = Date.now();
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await request(path, { timeoutMs: ATTEMPT_MS });
      } catch (error) {
        const elapsed = Date.now() - started;
        if (!isWaking(error) || elapsed + RETRY_DELAY_MS >= WAKE_TOTAL_MS) {
          if (isWaking(error)) {
            const final = new Error('The wallet testnet did not answer within 2 minutes. The free host may still be starting or restoring its saved state. Try again in a minute.');
            final.waking = true;
            throw final;
          }
          throw error;
        }
        if (onWait) onWait(attempt, Math.round(elapsed / 1000));
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  function wakeText(prefix) {
    return (attempt, seconds) => prefix + ' The free host is waking up or restoring its saved state (try ' + (attempt + 1) + ', ' + seconds + ' s so far). This can take up to 2 minutes.';
  }

  function renderStatus(next) {
    status = next;
    const ok = next && next.valueBearing === false && typeof next.chainId === 'string';
    text('[data-net-state]', ok
      ? 'Wallet testnet is reachable. Test ZYN has no value.'
      : 'The wallet testnet did not confirm that it is a no-value network.');
    text('[data-chain]', ok ? next.chainId : 'unknown');
    text('[data-tx-version]', ok && Number.isSafeInteger(next.transactionVersion) ? String(next.transactionVersion) : 'unknown');
    text('[data-height]', ok ? whole(next.height) : 'unknown');
    text('[data-genesis]', ok && typeof next.genesisHash === 'string' ? next.genesisHash : 'unknown');
    text('[data-durable]', !ok ? 'unknown' : next.stateDurable === true ? 'on' : next.stateDurable === false ? 'off' : 'unknown');
  }

  async function loadStatus() {
    text('[data-net-state]', 'Contacting the wallet testnet. A sleeping free host can take up to 2 minutes to wake.');
    try {
      const next = await getWithRetry('/status', (attempt, seconds) => text('[data-net-state]', wakeText('Still waiting.')(attempt, seconds)));
      if (!next || next.valueBearing !== false) throw new Error('Refusing to show a status that does not declare valueBearing: false');
      renderStatus(next);
    } catch (error) {
      status = null;
      text('[data-chain]', 'unknown');
      text('[data-tx-version]', 'unknown');
      text('[data-height]', 'unknown');
      text('[data-genesis]', 'unknown');
      text('[data-durable]', 'unknown');
      text('[data-net-state]', error instanceof Error ? error.message : 'The wallet testnet is not reachable right now.');
    }
  }

  function showAccount(account, parsed, genesisHash) {
    const box = $('[data-account]');
    box.hidden = false;
    text('[data-acc-address]', parsed.canonical);
    text('[data-acc-zyn]', formatZyn(account.balanceAtoms));
    text('[data-acc-atoms]', whole(account.balanceAtoms));
    text('[data-acc-nonce]', whole(account.nonce));
    text('[data-acc-next]', Number.isSafeInteger(account.nonce) && account.nonce >= 0 ? String(account.nonce + 1) : 'unknown');
    text('[data-acc-height]', whole(account.height));
    text('[data-acc-genesis]', typeof genesisHash === 'string' && genesisHash ? genesisHash : 'unknown');
    msg('[data-lookup-msg]', parsed.checksumVerified
      ? 'Checksum verified. Showing the canonical lowercase address.'
      : 'Lowercase address accepted. There is no checksum to verify, so compare it carefully.', 'good');
  }

  async function lookup() {
    const box = $('[data-account]');
    box.hidden = true;
    let parsed;
    try {
      parsed = await parseAddress($('[data-address]').value);
    } catch (error) {
      msg('[data-lookup-msg]', error instanceof Error ? error.message : 'Invalid address', 'bad');
      return;
    }
    msg('[data-lookup-msg]', 'Looking up ' + parsed.canonical + '…', '');
    try {
      const onWait = (attempt, seconds) => msg('[data-lookup-msg]', wakeText('Still looking up ' + parsed.canonical + '.')(attempt, seconds), '');
      const [account, live] = await Promise.all([getWithRetry('/account/' + parsed.canonical, onWait), status ? Promise.resolve(status) : getWithRetry('/status')]);
      if (!account || account.valueBearing === true) throw new Error('Refusing to show an account from a value-bearing response');
      if (live && live.valueBearing === false) renderStatus(live);
      if (account.address && account.address !== parsed.canonical) throw new Error('The network returned a different address');
      showAccount(account, parsed, (live && live.genesisHash) || (status && status.genesisHash));
    } catch (error) {
      msg('[data-lookup-msg]', error instanceof Error ? error.message : 'Lookup failed', 'bad');
    }
  }

  function clearReview() {
    reviewed = null;
    $('[data-review]').hidden = true;
    $('[data-submit]').disabled = true;
    msg('[data-submit-msg]', '', '');
  }

  function rejectSecret(value) {
    if (looksLikePhrase(value)) return 'This looks like a recovery phrase. This page does not accept a phrase, a password or a private key.';
    return '';
  }

  function validateTransfer(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Paste one signed transfer JSON object');
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== TRANSFER_KEYS.join(',')) {
      if (value.kind && value.kind !== 'transfer') throw new Error('Only a transfer can be submitted from this page');
      if (keys.some((key) => /private|mnemonic|seed|password|phrase/i.test(key))) throw new Error('This page does not accept a phrase, a password or a private key');
      throw new Error('The transfer must contain exactly the phone-wallet fields and no others');
    }
    if (value.kind !== 'transfer') throw new Error('Only a transfer can be submitted from this page');
    if (value.version !== 1 && value.version !== 2) throw new Error('Transaction version must be 1 or 2');
    if (typeof value.chainId !== 'string' || !/^[a-z0-9-]{3,64}$/.test(value.chainId)) throw new Error('Chain ID is missing or invalid');
    if (!Number.isSafeInteger(value.nonce) || value.nonce < 1) throw new Error('Nonce must be a whole number, 1 or more');
    if (!CANONICAL_RE.test(value.sender) || !CANONICAL_RE.test(value.receiver)) throw new Error('Sender and receiver must be canonical lowercase addresses');
    if (!Number.isSafeInteger(value.amountAtoms) || value.amountAtoms < 1) throw new Error('Amount must be at least 1 atom');
    if (!Number.isSafeInteger(value.feeAtoms) || value.feeAtoms < 0) throw new Error('Fee must be zero or more atoms');
    if (!Number.isSafeInteger(value.timestampMs) || value.timestampMs < 0) throw new Error('Timestamp is invalid');
    if (typeof value.publicKey !== 'string' || !HEX_RE.test(value.publicKey) || value.publicKey.length !== 128) throw new Error('Public key is invalid');
    if (typeof value.signature !== 'string' || !HEX_RE.test(value.signature) || value.signature.length !== 128) throw new Error('Signature is invalid');
    if (typeof value.txid !== 'string' || !HEX_RE.test(value.txid) || value.txid.length !== 64) throw new Error('Transaction id is invalid');
    if (!status || status.valueBearing !== false) throw new Error('Network status is unknown, so chain id and transaction version cannot be checked yet');
    if (value.chainId !== status.chainId) throw new Error('Chain ID does not match this network (' + status.chainId + ')');
    if (!Number.isSafeInteger(status.transactionVersion)) throw new Error('Expected transaction version is unknown');
    if (value.version !== status.transactionVersion) throw new Error('Transaction version ' + value.version + ' does not match this network (expected ' + status.transactionVersion + ')');
    return value;
  }

  async function reviewTransfer() {
    clearReview();
    const raw = $('[data-tx]').value;
    const secret = rejectSecret(raw);
    if (secret) { msg('[data-tx-msg]', secret, 'bad'); return; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { msg('[data-tx-msg]', 'That is not valid JSON', 'bad'); return; }
    try {
      if (!status) await loadStatus();
      const tx = validateTransfer(parsed);
      let baseline = null;
      try {
        const account = await request('/account/' + tx.receiver);
        if (account && Number.isSafeInteger(account.balanceAtoms)) baseline = account.balanceAtoms;
      } catch (_) { baseline = null; }
      reviewed = { tx, baseline };
      text('[data-rev-from]', tx.sender);
      text('[data-rev-to]', tx.receiver);
      text('[data-rev-amount]', formatZyn(tx.amountAtoms) + ' (' + tx.amountAtoms + ' atoms)');
      text('[data-rev-fee]', formatZyn(tx.feeAtoms) + ' (' + tx.feeAtoms + ' atoms)');
      text('[data-rev-nonce]', String(tx.nonce));
      $('[data-review]').hidden = false;
      $('[data-submit]').disabled = false;
      msg('[data-tx-msg]', 'Review the fields, then submit. Nothing has been sent yet.', 'good');
    } catch (error) {
      msg('[data-tx-msg]', error instanceof Error ? error.message : 'Could not review this transfer', 'bad');
    }
  }

  async function submitTransfer() {
    if (!reviewed) return;
    const { tx, baseline } = reviewed;
    $('[data-submit]').disabled = true;
    msg('[data-submit-msg]', 'Submitting…', '');
    try {
      const result = await request('/tx', { method: 'POST', body: JSON.stringify(tx) });
      const txid = result && typeof result.txid === 'string' ? result.txid : tx.txid;
      msg('[data-submit-msg]', 'Accepted. Transaction id ' + txid + '. Waiting for the receiver balance to change.', '');
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let changed = false;
      do {
        let account = null;
        try { account = await request('/account/' + tx.receiver); } catch (_) { account = null; }
        if (account && Number.isSafeInteger(account.balanceAtoms) && baseline !== null && account.balanceAtoms !== baseline) {
          changed = true;
          msg('[data-submit-msg]', 'Included. Transaction id ' + txid + '. Receiver balance is now ' + formatZyn(account.balanceAtoms) + ' (' + account.balanceAtoms + ' atoms).', 'good');
        }
        if (!changed && Date.now() < deadline) await sleep(POLL_MS);
      } while (!changed && Date.now() < deadline);
      if (!changed) msg('[data-submit-msg]', 'No receiver balance change yet. Transaction id ' + txid + '. The next block can take about 30 seconds. Balances can still reset if durable storage is off or the network was deliberately reset.', '');
    } catch (error) {
      $('[data-submit]').disabled = false;
      msg('[data-submit-msg]', error instanceof Error ? error.message : 'Submit failed', 'bad');
    }
  }

  $('[data-refresh]').addEventListener('click', () => { void loadStatus(); });
  let lookupBusy = false;
  $('[data-lookup]').addEventListener('click', () => {
    if (lookupBusy) return;
    lookupBusy = true;
    $('[data-lookup]').disabled = true;
    void lookup().finally(() => { lookupBusy = false; $('[data-lookup]').disabled = false; });
  });
  $('[data-address]').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void lookup(); } });
  $('[data-tx-review]').addEventListener('click', () => { void reviewTransfer(); });
  $('[data-tx]').addEventListener('input', clearReview);
  $('[data-submit]').addEventListener('click', () => { void submitTransfer(); });
  void loadStatus();
})();

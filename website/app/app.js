/*
 * ZyronChain PWA wallet UI (TESTNET / UNAUDITED).
 * Secrets never leave this page: no network APIs are used here (CSP connect-src 'none'),
 * IndexedDB holds only the encrypted vault, and the private key lives in memory only while unlocked.
 */
(function () {
  'use strict';

  if (window.top !== window.self) {
    document.documentElement.style.display = 'none';
    throw new Error('ZyronChain Wallet refuses to run inside a frame');
  }

  const core = globalThis.ZyronAppCore;
  const QR = globalThis.ZyronQR;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const AUTO_LOCK_MS = 5 * 60 * 1000;
  const WORD_HIDE_MS = 20 * 1000;
  const QUIZ_WORDS = 4;
  const BACKGROUND_LOCK_MS = 60 * 1000;
  const CLIPBOARD_CLEAR_MS = 60 * 1000;
  const DB_NAME = 'zyron-wallet-app';
  const STORE = 'vault';
  const VAULT_KEY = 'primary';

  // ---------------- UI strings (English only) ----------------
  const STRINGS = { en: {} };
  const EN_DYNAMIC = {
    msgPasswordsDiffer: 'Passwords do not match.',
    msgStrengthOk: 'Password accepted (about {bits} bits).',
    msgWeak: 'Password too weak: need 12+ characters, 6+ different characters and ~60 bits (now ~{bits} bits).',
    msgDeriving: 'Deriving and encrypting the key… (can take a few seconds on phones)',
    msgUnlocking: 'Unlocking… (can take a few seconds on phones)',
    msgQuizWord: 'Word #{n}',
    msgQuizWrong: 'One or more words are wrong. Check your paper or show the words again.',
    msgCopied: 'Copied. Clipboard will be cleared automatically.',
    msgCopyFailed: 'Could not copy; select and copy by hand.',
    msgWrongPassword: 'Wrong password, or the vault was modified.',
    msgLocked: 'Locked.',
    msgSigned: 'Signed locally. Not broadcast. txid {txid}',
    msgChecksumOk: 'Receiver checksum verified.',
    msgChecksumNone: 'Receiver has no checksum; double-check it.',
    msgUnsupported: 'This browser lacks required features (Web Crypto / IndexedDB / secure context). Use a current Safari or Chrome.',
    msgCryptoMissing: 'The wallet refuses to run: its cryptography libraries failed to load or failed the self-test ({message}). Reload the page; if this persists, do not use this device.',
    msgPersisted: 'Storage: marked persistent.',
    msgNotPersisted: 'Storage: the browser did not grant persistence; your paper recovery phrase is essential.',
    msgVaultExists: 'A wallet already exists on this device. Delete it first.',
    msgVaultRejected: 'The stored vault was rejected and left untouched: {message}',
    msgWordHidden: 'Word {n} of {total}, hidden. Activate to reveal.',
    msgWordShown: 'Word {n} of {total}: {word}',
    msgError: 'Error: {message}',
    meterEmpty: 'Strength: enter at least 12 characters.',
    meterShort: 'Strength: too short ({count} of 12 characters).',
    meterRepetitive: 'Strength: too repetitive (use 6+ different characters).',
    meterWeak: 'Strength: weak (about {bits} bits; need 60+).',
    meterFair: 'Strength: acceptable (about {bits} bits).',
    meterStrong: 'Strength: strong (about {bits} bits).',
    localOffline: 'Local wallet · Offline ready',
    localOnly: 'Local wallet'
  };
  for (const element of $$('[data-i18n]')) {
    const key = element.dataset.i18n;
    if (key in STRINGS.en && STRINGS.en[key] !== element.textContent) console.warn('UI key reused with different text: ' + key);
    STRINGS.en[key] = element.textContent;
  }
  Object.assign(STRINGS.en, EN_DYNAMIC);
  function t(key, vars) {
    let text = STRINGS.en[key] || key;
    if (vars) for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]));
    return text;
  }

  // ---------------- state ----------------
  // The recovery phrase is never kept as a long-lived string: during creation only the entropy bytes are held
  // (wipeable Uint8Array) and individual words are derived on demand for a revealed card or the backup check.
  const state = {
    vault: null,     // encrypted vault (public metadata + ciphertext)
    account: null,   // { privateKey: Uint8Array, publicKey, address } while unlocked
    pending: null,   // { vault, account, entropy, count } during create (before the backup check passes)
    quiz: null,      // shuffled word indexes for the backup check
    unsigned: null,  // transfer under review (not signed)
    lastTx: null,
    hiddenAt: 0,
    idleTimer: 0,
    wordTimer: 0,
    clipboardTimer: 0,
    installPrompt: null,
    rejectedVault: false
  };

  // ---------------- IndexedDB (encrypted vault only) ----------------
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function dbRequest(mode, run) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  const loadVault = () => dbRequest('readonly', (store) => store.get(VAULT_KEY));
  function saveVault(vault) {
    core.assertVaultShape(vault); // refuses to persist anything that is not an encrypted vault
    return dbRequest('readwrite', (store) => store.put(core.parseVault(vault), VAULT_KEY));
  }
  const deleteVault = () => dbRequest('readwrite', (store) => store.delete(VAULT_KEY));

  // ---------------- helpers ----------------
  function show(name) {
    if (name !== 'phrase') hideWords();
    for (const screen of $$('[data-screen]')) screen.hidden = screen.dataset.screen !== name;
    document.body.dataset.current = name;
    window.scrollTo(0, 0);
    const heading = $('[data-screen="' + name + '"] h1, [data-screen="' + name + '"] h2');
    if (heading && name !== 'welcome') { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
  }
  function setMessage(selector, text, kind) {
    const element = $(selector);
    element.textContent = text || '';
    element.classList.toggle('good', kind === 'good');
    element.classList.toggle('badtext', kind === 'bad');
  }
  async function busy(text, task) {
    $('[data-busy-text]').textContent = text;
    $('[data-busy]').hidden = false;
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
    try {
      return await task();
    } finally {
      $('[data-busy]').hidden = true;
    }
  }
  function clearInputs() {
    for (const input of $$('input[type="password"], [data-restore-phrase], [data-delete-confirm], [data-quiz] input')) input.value = '';
    for (const box of $$('[data-privacy-ack], [data-phrase-ack], [data-delete-ack], [data-review-ack]')) box.checked = false;
    for (const name of ['create', 'restore']) renderMeter(name, '');
  }
  function wipeAccount(account) {
    if (account && account.privateKey) core.wipe(account.privateKey);
  }
  function errorText(error) { return t('msgError', { message: error && error.message ? error.message : String(error) }); }
  function checkPasswordPair(first, second, target) {
    const strength = core.passwordStrength(first);
    if (!strength.ok) { setMessage(target, t('msgWeak', { bits: strength.bits }), 'bad'); return false; }
    if (first !== second) { setMessage(target, t('msgPasswordsDiffer'), 'bad'); return false; }
    setMessage(target, t('msgStrengthOk', { bits: strength.bits }), 'good');
    return true;
  }
  function randomIndexes(count, max) {
    const picked = [];
    const buffer = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / max) * max; // rejection sampling: no modulo bias
    while (picked.length < count) {
      crypto.getRandomValues(buffer);
      if (buffer[0] >= limit) continue;
      const index = buffer[0] % max;
      if (!picked.includes(index)) picked.push(index); // kept in random order on purpose
    }
    return picked;
  }

  // ---------------- password meter (same rule as the CLI; presentation only) ----------------
  function renderMeter(name, password) {
    const meter = $('[data-pw-meter="' + name + '"]');
    const text = $('[data-pw-meter-text="' + name + '"]');
    if (!meter || !text) return;
    const count = Array.from(password).length;
    const s = core.passwordStrength(password);
    let level = 0; let message = t('meterEmpty');
    if (!count) { level = 0; }
    else if (count < 12) { level = 1; message = t('meterShort', { count }); }
    else if (/repetitive/.test(s.reason)) { level = 1; message = t('meterRepetitive'); }
    else if (!s.ok) { level = 2; message = t('meterWeak', { bits: s.bits }); }
    else if (s.bits < 80) { level = 3; message = t('meterFair', { bits: s.bits }); }
    else { level = 4; message = t('meterStrong', { bits: s.bits }); }
    meter.dataset.level = String(level);
    text.textContent = message;
  }
  $('[data-create-password]').addEventListener('input', (event) => renderMeter('create', event.target.value));
  $('[data-restore-password]').addEventListener('input', (event) => renderMeter('restore', event.target.value));

  // ---------------- clipboard (address and signed transfer only; auto-clear) ----------------
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      clearTimeout(state.clipboardTimer);
      state.clipboardTimer = setTimeout(() => { navigator.clipboard.writeText('').catch(() => {}); }, CLIPBOARD_CLEAR_MS);
      return true;
    } catch (error) {
      return false;
    }
  }
  // The recovery phrase can never be copied: block copy/cut/drag from the word list and the backup check.
  for (const type of ['copy', 'cut', 'dragstart']) {
    document.addEventListener(type, (event) => {
      if (event.target && event.target.closest && event.target.closest('[data-phrase-words], [data-quiz]')) event.preventDefault();
    });
  }

  // ---------------- auto-lock ----------------
  function clearPending() {
    if (state.pending) {
      wipeAccount(state.pending.account);
      core.wipe(state.pending.entropy);
      state.pending.entropy = null;
      state.pending.vault = null;
    }
    state.pending = null;
    state.quiz = null;
    $('[data-phrase-words]').textContent = '';
    $('[data-quiz]').textContent = '';
  }
  function lock(message) {
    wipeAccount(state.account);
    state.account = null;
    clearPending();
    state.unsigned = null;
    state.lastTx = null;
    $('[data-tx-out]').hidden = true;
    $('[data-tx-json]').textContent = '';
    $('[data-review-rows]').textContent = '';
    $('[data-qr]').textContent = '';
    $('[data-created-note]').hidden = true;
    clearInputs();
    clearTimeout(state.idleTimer);
    if (state.vault) {
      $('[data-unlock-address]').textContent = core.groupAddress(core.toChecksumAddress(state.vault.address));
      setMessage('[data-unlock-result]', message || '', '');
      show('unlock');
    } else {
      show('welcome');
    }
  }
  function touch() {
    clearTimeout(state.idleTimer);
    if (state.account || state.pending) state.idleTimer = setTimeout(() => lock(t('msgLocked')), AUTO_LOCK_MS);
  }
  for (const type of ['pointerdown', 'keydown', 'input', 'touchstart']) document.addEventListener(type, touch, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hideWords();
      state.hiddenAt = Date.now();
      if (state.account || state.pending) state.idleTimer = setTimeout(() => lock(t('msgLocked')), BACKGROUND_LOCK_MS);
    } else if (state.hiddenAt && Date.now() - state.hiddenAt >= BACKGROUND_LOCK_MS && (state.account || state.pending)) {
      lock(t('msgLocked'));
    } else {
      touch();
    }
  });
  window.addEventListener('blur', hideWords);
  window.addEventListener('pagehide', () => { hideWords(); wipeAccount(state.account); if (state.pending) { wipeAccount(state.pending.account); core.wipe(state.pending.entropy); } });

  // ---------------- QR ----------------
  function renderQr(text) {
    const target = $('[data-qr]');
    target.textContent = '';
    const matrix = QR.encodeQR(text, 'raw', { ecc: 'medium', border: 2 });
    const size = matrix.length;
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    let d = '';
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (matrix[y][x]) d += 'M' + x + ' ' + y + 'h1v1h-1z';
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000');
    svg.appendChild(path);
    target.appendChild(svg);
    target.dataset.qrText = text;
  }

  // ---------------- home ----------------
  function showHome() {
    const address = state.account.address;
    $('[data-home-address]').textContent = core.groupAddress(core.toChecksumAddress(address));
    $('[data-home-raw]').textContent = address;
    renderQr(address);
    setMessage('[data-copy-result]', '', '');
    show('home');
    touch();
    refreshStorageStatus();
  }
  async function refreshStorageStatus() {
    try {
      if (navigator.storage && navigator.storage.persisted) {
        const persisted = (await navigator.storage.persisted()) || (navigator.storage.persist ? await navigator.storage.persist() : false);
        $('[data-storage-status]').textContent = persisted ? t('msgPersisted') : t('msgNotPersisted');
      }
    } catch (error) { /* informational only */ }
  }

  // ---------------- create flow: password -> privacy -> hidden words -> backup check -> save ----------------
  $('[data-create-next]').addEventListener('click', async () => {
    const first = $('[data-create-password]').value;
    const second = $('[data-create-password2]').value;
    if (!checkPasswordPair(first, second, '[data-strength]')) return;
    if (state.vault) { setMessage('[data-strength]', t('msgVaultExists'), 'bad'); return; }
    let entropy = null;
    try {
      const pending = await busy(t('msgDeriving'), async () => {
        entropy = core.generateEntropy();
        const account = await core.deriveAccount(entropy);
        const vault = await core.createVault(entropy, first, account);
        return { vault, account, entropy: Uint8Array.from(entropy), count: entropy.length * 3 / 4 };
      });
      clearInputs();
      clearPending();
      state.pending = pending;
      show('privacy');
      touch();
    } catch (error) {
      setMessage('[data-strength]', errorText(error), 'bad');
    } finally {
      core.wipe(entropy);
    }
  });
  $('[data-privacy-ack]').addEventListener('change', (event) => { $('[data-privacy-next]').disabled = !event.target.checked; });
  $('[data-privacy-next]').addEventListener('click', () => {
    if (!state.pending || !$('[data-privacy-ack]').checked) return;
    renderWordCards();
    $('[data-phrase-ack]').checked = false;
    $('[data-phrase-next]').disabled = true;
    show('phrase');
  });

  // Word cards: the real word is only put into the DOM while that card is revealed.
  function wordAt(index) {
    const words = core.entropyToPhrase(state.pending.entropy).split(' ');
    const word = words[index];
    words.fill('');
    return word;
  }
  function renderWordCards() {
    const list = $('[data-phrase-words]');
    list.textContent = '';
    for (let i = 0; i < state.pending.count; i += 1) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'word-card';
      button.dataset.wordIndex = String(i);
      const num = document.createElement('span');
      num.className = 'word-num';
      num.setAttribute('aria-hidden', 'true');
      num.textContent = String(i + 1);
      const text = document.createElement('span');
      text.className = 'word-text';
      text.setAttribute('aria-hidden', 'true');
      button.append(num, text);
      button.addEventListener('click', () => (button.dataset.revealed === 'true' ? setCard(button, false) : setCard(button, true)));
      li.appendChild(button);
      list.appendChild(li);
      setCard(button, false);
    }
  }
  function setCard(button, reveal) {
    const index = Number(button.dataset.wordIndex);
    const total = state.pending ? state.pending.count : 12;
    const text = button.querySelector('.word-text');
    if (reveal && state.pending) {
      const word = wordAt(index);
      text.textContent = word;
      button.dataset.revealed = 'true';
      button.setAttribute('aria-label', t('msgWordShown', { n: index + 1, total, word }));
      armWordTimer();
    } else {
      text.textContent = '•••••';
      button.dataset.revealed = 'false';
      button.setAttribute('aria-label', t('msgWordHidden', { n: index + 1, total }));
    }
  }
  function armWordTimer() {
    clearTimeout(state.wordTimer);
    state.wordTimer = setTimeout(hideWords, WORD_HIDE_MS);
  }
  function hideWords() {
    clearTimeout(state.wordTimer);
    for (const button of $$('[data-phrase-words] .word-card')) if (button.dataset.revealed === 'true') setCard(button, false);
  }
  function revealAll() { if (state.pending) for (const button of $$('[data-phrase-words] .word-card')) setCard(button, true); }
  const hold = $('[data-hold-reveal]');
  hold.addEventListener('pointerdown', (event) => { event.preventDefault(); revealAll(); });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) hold.addEventListener(type, hideWords);
  hold.addEventListener('keydown', (event) => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); revealAll(); } });
  hold.addEventListener('keyup', (event) => { if (event.key === ' ' || event.key === 'Enter') hideWords(); });
  hold.addEventListener('contextmenu', (event) => event.preventDefault());
  $('[data-hide-words]').addEventListener('click', hideWords);
  document.addEventListener('pointerdown', () => { if ($('[data-phrase-words] .word-card[data-revealed="true"]')) armWordTimer(); }, { passive: true });

  $('[data-phrase-ack]').addEventListener('change', (event) => { $('[data-phrase-next]').disabled = !event.target.checked; });
  function renderQuiz() {
    const box = $('[data-quiz]');
    box.textContent = '';
    state.quiz.forEach((index) => {
      const label = document.createElement('label');
      const span = document.createElement('span');
      span.textContent = t('msgQuizWord', { n: index + 1 });
      const input = document.createElement('input');
      for (const [name, value] of [['autocomplete', 'off'], ['autocapitalize', 'none'], ['autocorrect', 'off'], ['spellcheck', 'false'], ['data-1p-ignore', ''], ['data-lpignore', 'true']]) input.setAttribute(name, value);
      input.dataset.quizIndex = String(index);
      label.append(span, input);
      box.appendChild(label);
    });
  }
  $('[data-phrase-next]').addEventListener('click', () => {
    if (!state.pending) return show('welcome');
    state.quiz = randomIndexes(QUIZ_WORDS, state.pending.count);
    hideWords();
    $('[data-phrase-words]').textContent = ''; // cards leave the DOM during the check
    renderQuiz();
    setMessage('[data-quiz-result]', '', '');
    show('quiz');
  });
  $('[data-quiz-back]').addEventListener('click', () => {
    if (!state.pending) return show('welcome');
    $('[data-quiz]').textContent = '';
    renderWordCards();
    show('phrase');
  });
  $('[data-quiz-check]').addEventListener('click', async () => {
    if (!state.pending || !state.quiz) return show('welcome');
    const words = core.entropyToPhrase(state.pending.entropy).split(' ');
    const inputs = $$('[data-quiz] input');
    const ok = inputs.length === QUIZ_WORDS && inputs.every((input) => core.normalizePhrase(input.value) === words[Number(input.dataset.quizIndex)]);
    words.fill('');
    if (!ok) { setMessage('[data-quiz-result]', t('msgQuizWrong'), 'bad'); return; }
    try {
      await saveVault(state.pending.vault);
      state.vault = core.parseVault(state.pending.vault);
      state.account = state.pending.account;
      state.pending.account = null;
      clearPending(); // wipes entropy, drops vault/words references, empties the word list and the check
      showHome();
      $('[data-created-note]').hidden = false;
    } catch (error) {
      setMessage('[data-quiz-result]', errorText(error), 'bad');
    }
  });
  for (const button of $$('[data-cancel-create]')) button.addEventListener('click', () => { clearPending(); clearInputs(); show('welcome'); });

  // ---------------- restore ----------------
  $('[data-restore-go]').addEventListener('click', async () => {
    if (state.vault) { setMessage('[data-restore-result]', t('msgVaultExists'), 'bad'); return; }
    let entropy = null;
    try {
      entropy = core.phraseToEntropy($('[data-restore-phrase]').value);
    } catch (error) {
      setMessage('[data-restore-result]', errorText(error), 'bad');
      return;
    }
    const first = $('[data-restore-password]').value;
    if (!checkPasswordPair(first, $('[data-restore-password2]').value, '[data-restore-result]')) { core.wipe(entropy); return; }
    try {
      const result = await busy(t('msgDeriving'), async () => {
        const account = await core.deriveAccount(entropy);
        const vault = await core.createVault(entropy, first, account);
        return { vault, account };
      });
      await saveVault(result.vault);
      clearInputs();
      state.vault = core.parseVault(result.vault);
      state.account = result.account;
      showHome();
    } catch (error) {
      setMessage('[data-restore-result]', errorText(error), 'bad');
    } finally {
      core.wipe(entropy);
    }
  });

  // ---------------- unlock / lock ----------------
  async function unlock() {
    const password = $('[data-unlock-password]').value;
    setMessage('[data-unlock-result]', '', '');
    try {
      const opened = await busy(t('msgUnlocking'), () => core.openVault(state.vault, password));
      core.wipe(opened.entropy);
      clearInputs();
      state.account = opened.account;
      showHome();
    } catch (error) {
      setMessage('[data-unlock-result]', /authentication failed/.test(error.message) ? t('msgWrongPassword') : errorText(error), 'bad');
    }
  }
  $('[data-unlock-go]').addEventListener('click', unlock);
  $('[data-unlock-password]').addEventListener('keydown', (event) => { if (event.key === 'Enter') unlock(); });
  $('[data-lock]').addEventListener('click', () => lock(t('msgLocked')));

  // ---------------- copy address ----------------
  $('[data-copy-address]').addEventListener('click', async () => {
    if (!state.account) return;
    setMessage('[data-copy-result]', (await copyText(core.toChecksumAddress(state.account.address))) ? t('msgCopied') : t('msgCopyFailed'), '');
  });
  $('[data-copy-plain]').addEventListener('click', async () => {
    if (!state.account) return;
    setMessage('[data-copy-result]', (await copyText(state.account.address)) ? t('msgCopied') : t('msgCopyFailed'), '');
  });

  // ---------------- transfer: build -> review -> deliberate confirm -> sign locally ----------------
  $('[data-tx-to]').addEventListener('input', () => {
    const value = $('[data-tx-to]').value.trim();
    if (!value) return setMessage('[data-tx-check]', '', '');
    try {
      const parsed = core.parseAddressInput(value);
      setMessage('[data-tx-check]', parsed.checksumVerified ? t('msgChecksumOk') : t('msgChecksumNone'), parsed.checksumVerified ? 'good' : '');
    } catch (error) {
      setMessage('[data-tx-check]', error.message, 'bad');
    }
  });
  function renderReview(rows) {
    const box = $('[data-review-rows]');
    box.textContent = '';
    for (const row of rows) {
      const wrap = document.createElement('div');
      wrap.dataset.reviewKey = row.key;
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');
      dd.textContent = row.value;
      wrap.append(dt, dd);
      box.appendChild(wrap);
    }
  }
  $('[data-tx-review]').addEventListener('click', () => {
    if (!state.account) return lock();
    try {
      const unsigned = core.buildTransfer({
        version: Number($('[data-tx-version]').value),
        chainId: $('[data-tx-chain]').value,
        nonce: $('[data-tx-nonce]').value,
        receiver: $('[data-tx-to]').value,
        amountAtoms: core.zynToAtoms($('[data-tx-amount]').value),
        feeAtoms: core.zynToAtoms($('[data-tx-fee]').value || '0')
      }, state.account);
      renderReview(core.describeTransfer(unsigned));
      state.unsigned = unsigned;
      state.lastTx = null;
      $('[data-review-ack]').checked = false;
      $('[data-tx-sign]').disabled = true;
      $('[data-review-confirm-box]').hidden = false;
      $('[data-tx-out]').hidden = true;
      $('[data-tx-json]').textContent = '';
      setMessage('[data-review-error]', '', '');
      setMessage('[data-tx-check]', '', '');
      show('review');
    } catch (error) {
      setMessage('[data-tx-check]', errorText(error), 'bad');
    }
  });
  $('[data-review-ack]').addEventListener('change', (event) => { $('[data-tx-sign]').disabled = !event.target.checked; });
  $('[data-tx-sign]').addEventListener('click', () => {
    if (!state.account) return lock();
    if (!state.unsigned || !$('[data-review-ack]').checked) return;
    try {
      core.describeTransfer(state.unsigned); // re-check right before signing
      const tx = core.signTransfer(state.unsigned, state.account.privateKey);
      state.unsigned = null;
      state.lastTx = tx;
      $('[data-tx-json]').textContent = JSON.stringify(tx, null, 2);
      $('[data-tx-summary]').textContent = t('msgSigned', { txid: tx.txid });
      $('[data-review-confirm-box]').hidden = true;
      $('[data-tx-out]').hidden = false;
      setMessage('[data-tx-copy-result]', '', '');
    } catch (error) {
      setMessage('[data-review-error]', errorText(error), 'bad');
    }
  });
  function leaveReview() {
    state.unsigned = null;
    state.lastTx = null;
    $('[data-tx-json]').textContent = '';
    $('[data-review-rows]').textContent = '';
    if (state.account) showHome(); else lock();
  }
  $('[data-review-cancel]').addEventListener('click', leaveReview);
  $('[data-review-done]').addEventListener('click', leaveReview);
  $('[data-tx-copy]').addEventListener('click', async () => {
    if (state.lastTx) setMessage('[data-tx-copy-result]', (await copyText(JSON.stringify(state.lastTx))) ? t('msgCopied') : t('msgCopyFailed'), '');
  });
  $('[data-tx-download]').addEventListener('click', () => {
    if (!state.lastTx) return;
    const blob = new Blob([JSON.stringify(state.lastTx, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'zyron-transfer-nonce-' + state.lastTx.nonce + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ---------------- converter ----------------
  $('[data-conv-zyn]').addEventListener('input', () => {
    try { const atoms = core.zynToAtoms($('[data-conv-zyn]').value); $('[data-conv-atoms]').value = String(atoms); setMessage('[data-conv-result]', '1 ZYN = 100,000,000 atoms', ''); }
    catch (error) { setMessage('[data-conv-result]', error.message, 'bad'); }
  });
  $('[data-conv-atoms]').addEventListener('input', () => {
    try { $('[data-conv-zyn]').value = core.atomsToZyn($('[data-conv-atoms]').value); setMessage('[data-conv-result]', '1 ZYN = 100,000,000 atoms', ''); }
    catch (error) { setMessage('[data-conv-result]', error.message, 'bad'); }
  });

  // ---------------- delete: button -> confirmation screen -> explicit confirmation ----------------
  function updateDeleteButton() {
    const typed = $('[data-delete-confirm]').value.trim().toUpperCase() === 'DELETE';
    $('[data-delete-go]').disabled = !(typed && $('[data-delete-ack]').checked);
  }
  $('[data-delete-confirm]').addEventListener('input', updateDeleteButton);
  $('[data-delete-ack]').addEventListener('change', updateDeleteButton);
  $('[data-delete-go]').addEventListener('click', async () => {
    if ($('[data-delete-go]').disabled) return;
    try {
      await deleteVault();
      wipeAccount(state.account);
      state.account = null;
      state.vault = null;
      if (state.rejectedVault) {
        state.rejectedVault = false;
        $('[data-unsupported]').hidden = true;
        $('[data-rejected-delete]').hidden = true;
        for (const button of $$('[data-go="create"], [data-go="restore"], [data-unlock-go]')) button.disabled = false;
      }
      clearInputs();
      $('[data-delete-go]').disabled = true;
      lock();
    } catch (error) {
      setMessage('[data-unlock-result]', errorText(error), 'bad');
    }
  });
  $('[data-delete-cancel]').addEventListener('click', () => (state.account ? showHome() : lock()));

  // ---------------- navigation ----------------
  for (const button of $$('[data-go]')) {
    button.addEventListener('click', () => {
      const target = button.dataset.go;
      if (target === 'delete') { $('[data-delete-confirm]').value = ''; $('[data-delete-ack]').checked = false; $('[data-delete-go]').disabled = true; }
      setMessage('[data-strength]', t('ruleText'), '');
      show(target);
    });
  }

  // ---------------- install (Android prompt + iOS instructions) ----------------
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('[data-installed]').hidden = !isStandalone;
  for (const block of $$('[data-platform]')) block.classList.toggle('current', (block.dataset.platform === 'ios') === isIos);
  if (isIos) $('.install-steps').prepend($('[data-platform="ios"]'));
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    $('[data-install-button]').hidden = false;
  });
  $('[data-install-button]').addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice.catch(() => null);
    state.installPrompt = null;
    $('[data-install-button]').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('[data-install-button]').hidden = true; $('[data-installed]').hidden = false; });

  // ---------------- service worker (offline app shell; never sees secrets) ----------------
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).catch(() => {});
  }

  // ---------------- local / offline-ready indicator (never implies a network connection) ----------------
  function refreshLocalIndicator() {
    const ready = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    $('[data-local-text]').textContent = ready ? t('localOffline') : t('localOnly');
    $('[data-local-indicator]').classList.toggle('ready', ready);
  }
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('controllerchange', refreshLocalIndicator);

  // ---------------- start ----------------
  function refuse(text) {
    const warn = $('[data-unsupported]');
    warn.textContent = text;
    warn.hidden = false;
    for (const button of $$('[data-go="create"], [data-go="restore"], [data-unlock-go]')) button.disabled = true;
    show('welcome');
  }
  async function start() {
    document.documentElement.lang = 'en';
    refreshLocalIndicator();
    const supported = window.isSecureContext && window.crypto && crypto.subtle && typeof indexedDB !== 'undefined' && core && QR && typeof QR.encodeQR === 'function';
    if (!supported) return refuse(core && QR ? t('msgUnsupported') : t('msgCryptoMissing', { message: 'libraries not loaded' }));
    try {
      await core.selfTest();
    } catch (error) {
      return refuse(t('msgCryptoMissing', { message: error && error.message ? error.message : String(error) }));
    }
    try {
      const stored = await loadVault();
      if (stored !== undefined) state.vault = core.parseVault(stored); // unknown or malformed vaults are rejected, never rewritten
    } catch (error) {
      state.vault = null;
      state.rejectedVault = true;
      refuse(t('msgVaultRejected', { message: error && error.message ? error.message : String(error) }));
      $('[data-rejected-delete]').hidden = false;
      $('[data-rejected-delete]').disabled = false;
      return;
    }
    lock();
  }
  start();
})();

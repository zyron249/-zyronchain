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
  const BACKGROUND_LOCK_MS = 60 * 1000;
  const CLIPBOARD_CLEAR_MS = 60 * 1000;
  const DB_NAME = 'zyron-wallet-app';
  const STORE = 'vault';
  const VAULT_KEY = 'primary';

  // ---------------- i18n ----------------
  const STRINGS = { en: {}, tr: {
    badge: 'TESTNET · DENETLENMEDİ',
    scamTitle: 'Dolandırıcılık uyarısı',
    scamBody: 'ZyronChain\'den hiç kimse kurtarma kelimelerinizi veya şifrenizi asla istemez: ne destek, ne airdrop, ne "validator". İsteyen herkes hırsızdır. Henüz token satışı ve gerçek değer taşıyan herkese açık bir ağ yok.',
    welcomeTitle: 'ZyronChain cüzdanınız, telefonunuzda.',
    welcomeLead: 'Anahtarlar bu cihazın güvenli rastgele üreticisiyle burada oluşturulur ve yalnızca şifreli bir kasa olarak saklanır. Hesap yok, sunucu yok, uygulama mağazası yok.',
    fact1: 'Yalnızca testnet. Bu kod bağımsız olarak denetlenmedi: bağımsız inceleme yapılana kadar gerçek fonlar için kullanmayın.',
    fact2: 'Henüz herkese açık RPC yok; bu yüzden bakiye ve yayınlama kapalı. Cüzdan oluşturabilir, yedekleyebilir, adresinizi paylaşabilir ve transferleri çevrimdışı imzalayabilirsiniz.',
    fact3: 'ZyronChain MetaMask Snap ile aynı türetme yolu (m/44\'/249249\'/0\'/0/0): aynı 12 kelime ikisinde de aynı adresi verir.',
    create: 'Yeni cüzdan oluştur',
    restoreStart: '12 kelimeyle geri yükle',
    restoreGo: 'Geri yükle',
    createTitle: '1 / 3 · Şifre belirleyin',
    createLead: 'Şifre, cüzdanı bu telefonda şifreler. Kurtarılamaz; asıl yedeğiniz 12 kelimedir.',
    password: 'Şifre',
    passwordAgain: 'Şifre (tekrar)',
    ruleText: 'En az 12 karakter, en az 6 farklı karakter, yaklaşık 60+ bit (CLI ile aynı kural).',
    continue: 'Devam',
    back: 'Geri',
    cancel: 'İptal',
    phraseTitle: '2 / 3 · 12 kelimeyi yazın',
    phraseWarn: 'Bu kelimeleri sırasıyla kâğıda yazın ve çevrimdışı saklayın. Ekran görüntüsü almayın, fotoğraflamayın, kopyalamayın, e-postayla göndermeyin, bulut notuna kaydetmeyin. Bu kelimelere sahip olan cüzdana sahip olur. Yalnızca bir kez gösterilir.',
    phraseAck: '12 kelimenin hepsini sırasıyla kâğıda yazdım.',
    quizTitle: '3 / 3 · Yedeğinizi kanıtlayın',
    quizLead: 'İstenen kelimeleri kâğıdınızdan yazın. Cüzdan yalnızca bu kontrol geçtikten sonra kaydedilir.',
    verifySave: 'Doğrula ve cüzdanı kaydet',
    showAgain: 'Kelimeleri tekrar göster',
    restoreTitle: 'Kurtarma kelimeleriyle geri yükle',
    restoreLead: '12 kelimenizi (24 de olur) boşlukla ayırarak girin. ZyronChain MetaMask Snap\'te kullanılan aynı kelimeler aynı adresi verir.',
    phrase: 'Kurtarma kelimeleri',
    newPassword: 'Bu telefon için yeni şifre',
    unlockTitle: 'Cüzdanı aç',
    unlock: 'Aç',
    forgot: 'Şifreyi mi unuttunuz?',
    forgotBody: 'Şifre sıfırlanamaz. Bu kasayı silin ve 12 kelimenizle yeni bir şifreyle geri yükleyin.',
    deleteWallet: 'Cüzdanı bu telefondan sil',
    receiveTitle: 'Adresiniz',
    lock: 'Kilitle',
    qrHint: 'QR kod, zincirin kullandığı düz küçük harfli adresi içerir. Yukarıdaki büyük/küçük harfli biçim yalnızca görüntüleme sağlama toplamıdır (docs/ADDRESS_CHECKSUM.md).',
    copyChecksummed: 'Adresi kopyala',
    copyPlain: 'Düz biçimi kopyala',
    balanceTitle: 'Bakiye ve gönderme',
    noRpc: 'Henüz herkese açık RPC yok: bakiye gösterilemez ve bu uygulamadan hiçbir şey yayınlanamaz. Aşağıda imzalanan transferler, herkese açık ağ olduğunda CLI (tx-submit) ile daha sonra gönderebileceğiniz dosyalardır.',
    broadcastDisabled: 'Yayınla (kapalı: herkese açık RPC yok)',
    signTitle: 'Transferi çevrimdışı imzala',
    signLead: 'Tam olarak L1 transfer biçimini üretir. Zincir kimliği ve sıradaki nonce resmi bir duyurudan elle girilmelidir. Yalnızca transfer imzalanabilir; madencilik talebi (mining_claim) imkânsızdır.',
    chainId: 'Zincir kimliği (Chain ID)',
    nonce: 'Sıradaki nonce',
    receiver: 'Alıcı adresi',
    amount: 'Miktar (ZYN)',
    fee: 'Ücret (ZYN)',
    txVersion: 'İşlem sürümü',
    sign: 'Gözden geçir ve imzala',
    copyTx: 'İmzalı transferi kopyala',
    downloadTx: 'tx.json indir',
    convTitle: 'ZYN ↔ atom',
    securityTitle: 'Güvenlik',
    sec1: 'Bu telefonda yalnızca şifreli bir kasa saklanır (scrypt N=2^17 + AES-256-GCM). Anahtar yalnızca kilit açıkken bellekte bulunur.',
    sec2: '5 dakika işlem yapılmazsa veya uygulama 60 saniye arka planda kalırsa otomatik kilitlenir.',
    sec3: 'Kopyalanan metin 60 saniye sonra panodan silinir (tarayıcı izin verdiğinde).',
    sec4: 'iPhone/iPad: depolama azalırsa veya uygulama silinirse tarayıcı site verilerini silebilir. Tek gerçek yedek, 12 kelimenin kâğıttaki kopyasıdır.',
    deleteTitle: 'Cüzdan bu telefondan silinsin mi?',
    deleteWarn: 'Bu işlem şifreli kasayı bu cihazdan siler. 12 kelimeniz yazılı değilse cüzdan ve ona gönderilen her şey sonsuza dek kaybolur.',
    deleteType: 'Onaylamak için SİL (veya DELETE) yazın',
    deleteNow: 'Kalıcı olarak sil',
    installTitle: 'Telefona kur / Install on phone',
    installed: 'Kurulu: ana ekran uygulamasını kullanıyorsunuz.',
    installNow: 'Uygulamayı kur',
    ios1: 'zyronchain.com/app/ adresini Safari\'de açın.',
    ios2: 'Paylaş düğmesine dokunun (oklu kare).',
    ios3: '"Ana Ekrana Ekle"yi, ardından "Ekle"yi seçin.',
    ios4: 'Zyron Wallet\'ı ana ekrandan açın (çevrimdışı da çalışır).',
    and1: 'zyronchain.com/app/ adresini Chrome\'da açın.',
    and2: 'Yukarıdaki "Uygulamayı kur"a veya ⋮ menüsü → "Uygulamayı yükle" / "Ana ekrana ekle"ye dokunun.',
    and3: '"Yükle"yi onaylayın. Uygulama tam ekran açılır ve çevrimdışı çalışır.',
    foot: 'Açık kaynak; yalnızca zyronchain.com\'dan, sabitlenmiş ve bütünlüğü doğrulanmış kütüphanelerle sunulur (@noble/curves, @noble/hashes, @scure/bip39, @scure/bip32, qr). Denetlenmemiş testnet yazılımı.',
    cliLink: 'Bilgisayarı mı tercih edersiniz? CLI cüzdan kurulumu',
    // dynamic
    msgPasswordsDiffer: 'Şifreler eşleşmiyor.',
    msgStrengthOk: 'Şifre gücü uygun (yaklaşık {bits} bit).',
    msgWeak: 'Şifre zayıf: en az 12 karakter, 6 farklı karakter ve ~60 bit gerekir (şu an ~{bits} bit).',
    msgDeriving: 'Anahtar türetiliyor ve şifreleniyor… (telefonlarda birkaç saniye sürebilir)',
    msgUnlocking: 'Kilit açılıyor… (telefonlarda birkaç saniye sürebilir)',
    msgQuizWord: '{n}. kelime',
    msgQuizWrong: 'Bir veya daha fazla kelime yanlış. Kâğıdınızı kontrol edin veya kelimeleri tekrar gösterin.',
    msgSaved: 'Cüzdan kaydedildi.',
    msgCopied: 'Kopyalandı. Pano 60 saniye sonra temizlenecek.',
    msgCopyFailed: 'Kopyalanamadı; elle seçip kopyalayın.',
    msgWrongPassword: 'Şifre yanlış veya kasa değiştirilmiş.',
    msgLocked: 'Kilitlendi.',
    msgSigned: 'İmzalandı (yayınlanmadı): {amount} ZYN → {to}, ücret {fee} ZYN, zincir {chain}, nonce {nonce}. txid {txid}',
    msgChecksumOk: 'Alıcı sağlama toplamı doğrulandı.',
    msgChecksumNone: 'Alıcıda sağlama toplamı yok; dikkatle kontrol edin.',
    msgUnsupported: 'Bu tarayıcı gerekli özellikleri desteklemiyor (Web Crypto / IndexedDB / güvenli bağlantı). Güncel Safari veya Chrome kullanın.',
    msgPersisted: 'Depolama: kalıcı olarak işaretlendi.',
    msgNotPersisted: 'Depolama: tarayıcı kalıcılık garantisi vermedi; 12 kelimelik yedeğiniz şarttır.',
    msgVaultExists: 'Bu telefonda zaten bir cüzdan var. Önce silin.',
    msgError: 'Hata: {message}'
  } };
  const EN_DYNAMIC = {
    msgPasswordsDiffer: 'Passwords do not match.',
    msgStrengthOk: 'Password strength OK (about {bits} bits).',
    msgWeak: 'Password too weak: need 12+ characters, 6+ different characters and ~60 bits (now ~{bits} bits).',
    msgDeriving: 'Deriving and encrypting the key… (can take a few seconds on phones)',
    msgUnlocking: 'Unlocking… (can take a few seconds on phones)',
    msgQuizWord: 'Word #{n}',
    msgQuizWrong: 'One or more words are wrong. Check your paper or show the words again.',
    msgSaved: 'Wallet saved.',
    msgCopied: 'Copied. The clipboard will be cleared in 60 seconds.',
    msgCopyFailed: 'Could not copy; select and copy by hand.',
    msgWrongPassword: 'Wrong password, or the vault was modified.',
    msgLocked: 'Locked.',
    msgSigned: 'Signed (not broadcast): {amount} ZYN → {to}, fee {fee} ZYN, chain {chain}, nonce {nonce}. txid {txid}',
    msgChecksumOk: 'Receiver checksum verified.',
    msgChecksumNone: 'Receiver has no checksum; double-check it.',
    msgUnsupported: 'This browser lacks required features (Web Crypto / IndexedDB / secure context). Use a current Safari or Chrome.',
    msgPersisted: 'Storage: marked persistent.',
    msgNotPersisted: 'Storage: the browser did not grant persistence; your 12-word backup is essential.',
    msgVaultExists: 'A wallet already exists on this phone. Delete it first.',
    msgError: 'Error: {message}'
  };
  for (const element of $$('[data-i18n]')) {
    const key = element.dataset.i18n;
    if (key in STRINGS.en && STRINGS.en[key] !== element.textContent) console.warn('i18n key reused with different text: ' + key);
    STRINGS.en[key] = element.textContent;
  }
  Object.assign(STRINGS.en, EN_DYNAMIC);
  let lang = /^tr\b/i.test(navigator.language || '') ? 'tr' : 'en';
  function t(key, vars) {
    let text = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
    if (vars) for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]));
    return text;
  }
  function applyLang() {
    document.documentElement.lang = lang;
    for (const element of $$('[data-i18n]')) element.textContent = t(element.dataset.i18n);
    $('[data-lang-toggle]').textContent = lang === 'tr' ? 'EN' : 'TR';
    if (state.quiz) renderQuiz();
  }

  // ---------------- state ----------------
  const state = {
    vault: null,     // encrypted vault (public metadata + ciphertext)
    account: null,   // { privateKey: Uint8Array, publicKey, address } while unlocked
    pending: null,   // { vault, account, words } during create (before the quiz passes)
    quiz: null,      // [index, index, index]
    lastTx: null,
    hiddenAt: 0,
    idleTimer: 0,
    clipboardTimer: 0,
    installPrompt: null
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
    return dbRequest('readwrite', (store) => store.put(JSON.parse(JSON.stringify(vault)), VAULT_KEY));
  }
  const deleteVault = () => dbRequest('readwrite', (store) => store.delete(VAULT_KEY));

  // ---------------- helpers ----------------
  function show(name) {
    for (const screen of $$('[data-screen]')) screen.hidden = screen.dataset.screen !== name;
    document.body.dataset.current = name;
    window.scrollTo(0, 0);
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
    for (const input of $$('input[type="password"], [data-restore-phrase], [data-delete-confirm]')) input.value = '';
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
    const picked = new Set();
    const buffer = new Uint32Array(1);
    while (picked.size < count) {
      crypto.getRandomValues(buffer);
      picked.add(buffer[0] % max);
    }
    return Array.from(picked).sort((a, b) => a - b);
  }

  // ---------------- clipboard (auto-clear) ----------------
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

  // ---------------- auto-lock ----------------
  function lock(message) {
    wipeAccount(state.account);
    state.account = null;
    if (state.pending) { wipeAccount(state.pending.account); state.pending = null; state.quiz = null; $('[data-phrase-words]').textContent = ''; }
    state.lastTx = null;
    $('[data-tx-out]').hidden = true;
    $('[data-tx-json]').textContent = '';
    $('[data-qr]').textContent = '';
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
      state.hiddenAt = Date.now();
      if (state.account || state.pending) state.idleTimer = setTimeout(() => lock(t('msgLocked')), BACKGROUND_LOCK_MS);
    } else if (state.hiddenAt && Date.now() - state.hiddenAt >= BACKGROUND_LOCK_MS && (state.account || state.pending)) {
      lock(t('msgLocked'));
    } else {
      touch();
    }
  });
  window.addEventListener('pagehide', () => { wipeAccount(state.account); if (state.pending) wipeAccount(state.pending.account); });

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

  // ---------------- create flow ----------------
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
        const words = core.entropyToPhrase(entropy).split(' ');
        return { vault, account, words };
      });
      clearInputs();
      state.pending = pending;
      const list = $('[data-phrase-words]');
      list.textContent = '';
      for (const word of pending.words) { const li = document.createElement('li'); li.textContent = word; list.appendChild(li); }
      $('[data-phrase-ack]').checked = false;
      $('[data-phrase-next]').disabled = true;
      show('phrase');
      touch();
    } catch (error) {
      setMessage('[data-strength]', errorText(error), 'bad');
    } finally {
      core.wipe(entropy);
    }
  });
  $('[data-phrase-ack]').addEventListener('change', (event) => { $('[data-phrase-next]').disabled = !event.target.checked; });
  function renderQuiz() {
    const box = $('[data-quiz]');
    const values = $$('[data-quiz] input').map((input) => input.value);
    box.textContent = '';
    state.quiz.forEach((index, i) => {
      const label = document.createElement('label');
      const span = document.createElement('span');
      span.textContent = t('msgQuizWord', { n: index + 1 });
      const input = document.createElement('input');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('autocapitalize', 'none');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('spellcheck', 'false');
      input.dataset.quizIndex = String(index);
      input.value = values[i] || '';
      label.append(span, input);
      box.appendChild(label);
    });
  }
  $('[data-phrase-next]').addEventListener('click', () => {
    if (!state.pending) return show('welcome');
    state.quiz = randomIndexes(3, state.pending.words.length);
    renderQuiz();
    $('[data-phrase-words]').textContent = ''; // words leave the DOM while quizzing
    setMessage('[data-quiz-result]', '', '');
    show('quiz');
  });
  $('[data-quiz-back]').addEventListener('click', () => {
    if (!state.pending) return show('welcome');
    const list = $('[data-phrase-words]');
    list.textContent = '';
    for (const word of state.pending.words) { const li = document.createElement('li'); li.textContent = word; list.appendChild(li); }
    show('phrase');
  });
  $('[data-quiz-check]').addEventListener('click', async () => {
    if (!state.pending) return show('welcome');
    const ok = $$('[data-quiz] input').every((input) => core.normalizePhrase(input.value) === state.pending.words[Number(input.dataset.quizIndex)]);
    if (!ok) { setMessage('[data-quiz-result]', t('msgQuizWrong'), 'bad'); return; }
    try {
      await saveVault(state.pending.vault);
      state.vault = state.pending.vault;
      state.account = state.pending.account;
      state.pending.words.fill('');
      state.pending = null;
      state.quiz = null;
      $('[data-quiz]').textContent = '';
      showHome();
    } catch (error) {
      setMessage('[data-quiz-result]', errorText(error), 'bad');
    }
  });
  $('[data-cancel-create]').addEventListener('click', () => {
    if (state.pending) { wipeAccount(state.pending.account); state.pending.words.fill(''); }
    state.pending = null;
    state.quiz = null;
    $('[data-phrase-words]').textContent = '';
    show('welcome');
  });

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
      state.vault = result.vault;
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

  // ---------------- transfer signing ----------------
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
  $('[data-tx-sign]').addEventListener('click', () => {
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
      const tx = core.signTransfer(unsigned, state.account.privateKey);
      state.lastTx = tx;
      $('[data-tx-json]').textContent = JSON.stringify(tx, null, 2);
      $('[data-tx-summary]').textContent = t('msgSigned', {
        amount: core.atomsToZyn(String(tx.amountAtoms)), to: core.toChecksumAddress(tx.receiver), fee: core.atomsToZyn(String(tx.feeAtoms)),
        chain: tx.chainId, nonce: tx.nonce, txid: tx.txid
      });
      $('[data-tx-out]').hidden = false;
      setMessage('[data-tx-check]', '', '');
    } catch (error) {
      $('[data-tx-out]').hidden = true;
      setMessage('[data-tx-check]', errorText(error), 'bad');
    }
  });
  $('[data-tx-copy]').addEventListener('click', async () => {
    if (state.lastTx) setMessage('[data-tx-check]', (await copyText(JSON.stringify(state.lastTx))) ? t('msgCopied') : t('msgCopyFailed'), '');
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

  // ---------------- delete ----------------
  $('[data-delete-confirm]').addEventListener('input', (event) => {
    const value = event.target.value.trim().toLocaleUpperCase('tr');
    $('[data-delete-go]').disabled = !(value === 'DELETE' || value === 'SİL' || value === 'SIL');
  });
  $('[data-delete-go]').addEventListener('click', async () => {
    try {
      await deleteVault();
      wipeAccount(state.account);
      state.account = null;
      state.vault = null;
      clearInputs();
      $('[data-delete-go]').disabled = true;
      lock();
    } catch (error) {
      alert(errorText(error));
    }
  });
  $('[data-delete-cancel]').addEventListener('click', () => (state.account ? showHome() : lock()));

  // ---------------- navigation ----------------
  for (const button of $$('[data-go]')) {
    button.addEventListener('click', () => {
      const target = button.dataset.go;
      if (target === 'delete') { $('[data-delete-confirm]').value = ''; $('[data-delete-go]').disabled = true; }
      setMessage('[data-strength]', t('ruleText'), '');
      show(target);
    });
  }
  $('[data-lang-toggle]').addEventListener('click', () => { lang = lang === 'tr' ? 'en' : 'tr'; applyLang(); });

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

  // ---------------- start ----------------
  async function start() {
    applyLang();
    const supported = window.isSecureContext && window.crypto && crypto.subtle && typeof indexedDB !== 'undefined' && core && QR;
    if (!supported) {
      const warn = $('[data-unsupported]');
      warn.textContent = t('msgUnsupported');
      warn.hidden = false;
      for (const button of $$('[data-go="create"], [data-go="restore"]')) button.disabled = true;
      show('welcome');
      return;
    }
    try {
      const stored = await loadVault();
      if (stored) { core.assertVaultShape(stored); state.vault = stored; }
    } catch (error) {
      const warn = $('[data-unsupported]');
      warn.textContent = errorText(error);
      warn.hidden = false;
    }
    lock();
  }
  start();
})();

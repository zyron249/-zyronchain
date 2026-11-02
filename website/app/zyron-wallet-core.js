/*
 * ZyronChain PWA wallet core (TESTNET / UNAUDITED).
 *
 * Pure logic used by website/app/app.js and by the Node tests:
 *   - BIP-39 phrase -> BIP-32 m/44'/249249'/0'/0/0 -> secp256k1 key (same path as the MetaMask Snap, PR #922)
 *   - ZyronChain address = "ZYN" + first 40 hex of SHA-256(64-byte uncompressed public key) (l1/src/crypto.ts)
 *   - display-only checksum (docs/ADDRESS_CHECKSUM.md)
 *   - encrypted vault: scrypt(N=2^17, r=8, p=1) + AES-256-GCM, AAD binds version, KDF params, path, public key, address
 *     version 2 adds an encrypted "book" (address book, sent-to history, send-warning threshold) sealed with the same
 *     key; version 1 vaults stay readable and are upgraded only after a successful unlock (upgradeVault)
 *   - local send-safety checks (sendWarnings): first-time recipient, own address, amount at or above a threshold
 *   - offline l1 `transfer` signing, byte-identical to l1 createTransfer (only `transfer`; mining_claim is impossible)
 *
 * Needs globalThis.ZyronVendor (website/app/vendor/noble-scure.js) and Web Crypto (getRandomValues, subtle AES-GCM).
 * This file never performs network I/O and never touches storage.
 */
(function (root) {
  'use strict';

  const DERIVATION_PATH = "m/44'/249249'/0'/0/0";
  const VAULT_FORMAT = 'zyronchain-pwa-vault';
  const VAULT_VERSION = 2;
  const VAULT_VERSION_V1 = 1;
  const SELF_SEND_MESSAGE = "You can't send to your own address. Enter a different recipient.";
  const VAULT_KDF = Object.freeze({ name: 'scrypt', n: 131072, r: 8, p: 1, dkLen: 32 });
  const VAULT_CIPHER = 'aes-256-gcm';
  const VAULT_KEYS_V1 = ['address', 'cipher', 'ciphertext', 'createdAt', 'derivationPath', 'format', 'kdf', 'publicKey', 'salt', 'version', 'words'];
  const VAULT_KEYS = ['address', 'book', 'cipher', 'ciphertext', 'createdAt', 'derivationPath', 'format', 'kdf', 'publicKey', 'salt', 'version', 'words'];
  // Encrypted book limits (keep the stored vault small and bounded).
  const BOOK_MAX_CONTACTS = 100;
  const BOOK_MAX_SENT = 200;
  const BOOK_NAME_MAX = 64;
  const BOOK_MAX_PLAINTEXT = 32768;
  // Lookalike (address-poisoning) check: a known address that is NOT the same full address but whose
  // common hex prefix length + common hex suffix length (non-overlapping) is at least LOOKALIKE_MIN_SHARED,
  // for any split (3+3, 5+1, 6+0, 0+6, ...), or that differs in at most LOOKALIKE_MAX_DIFF hex positions.
  // At most LOOKALIKE_MAX_COMPARISONS known addresses (contacts first, then sent history) are compared.
  const LOOKALIKE_MIN_SHARED = 6;
  const LOOKALIKE_MAX_DIFF = 2;
  const LOOKALIKE_MAX_COMPARISONS = 250;
  const LOOKALIKE_MAX_MATCHES = 3;
  const MAX_VAULT_TEXT = 2 * BOOK_MAX_PLAINTEXT + 4096;
  const ATOMS_PER_ZYN = 100000000;
  // Proposed fixed protocol fee: 0.001 ZYN. Same constant as l1 FIXED_TRANSFER_FEE_ATOMS.
  const FIXED_TRANSFER_FEE_ATOMS = ATOMS_PER_ZYN / 1000;
  // Published fixed-supply-v1 chain IDs. Offline signing cannot read a genesis,
  // so these IDs are the default for that profile. zyron-wallet-testnet-1 is not one of them.
  const FIXED_SUPPLY_V1_CHAIN_IDS = ['zyron-open-testnet-1', 'zyron-open-testnet-render-1', 'zyron-public-testnet-1'];
  function fixedFeeRejection(input) {
    if (!input || typeof input !== 'object') return undefined;
    const chainId = String(input.chainId == null ? '' : input.chainId);
    const required = input.fixedTransferFeeAtoms == null ? FIXED_TRANSFER_FEE_ATOMS : input.fixedTransferFeeAtoms;
    if (!Number.isSafeInteger(required) || required < 1) return undefined;
    let enforced = false;
    if (input.feePolicyActive === true || input.launchProfile === 'fixed-supply-v1') enforced = true;
    else if (typeof input.launchProfile === 'string') enforced = false;
    else enforced = FIXED_SUPPLY_V1_CHAIN_IDS.indexOf(chainId) !== -1;
    if (!enforced || input.feeAtoms === required) return undefined;
    const zyn = required === FIXED_TRANSFER_FEE_ATOMS ? ' (0.001 ZYN)' : '';
    return 'This network will reject this fee. The protocol fee is ' + required + ' atoms' + zyn + '. Nothing was signed.';
  }
  const MAX_SUPPLY_ATOMS = 50000000 * ATOMS_PER_ZYN;
  const MINING_TRACKER_ADDRESS = 'ZYN' + '0'.repeat(40);
  const TRANSFER_SIGNING_DOMAIN_V2 = 'zyronchain/transaction/transfer/v2';
  const ADDRESS_CHECKSUM_DOMAIN = 'zyronchain/address-checksum/v1:';
  const CHAIN_ID_RE = /^[a-z0-9-]{3,64}$/;
  const TEST_CHAIN_ID_RE = /(^|-)(testnet|devnet)(-|$)/;
  const WALLET_TESTNET_CHAIN_ID = 'zyron-wallet-testnet-1';
  // That chain runs protocol version 1 and rejects transaction version 2.
  // Every other testnet or devnet id keeps version 2 as the selectable default.
  function defaultTransferVersion(chainId) {
    return String(chainId == null ? '' : chainId).trim() === WALLET_TESTNET_CHAIN_ID ? 1 : 2;
  }
  const ADDRESS_RE = /^ZYN[0-9a-f]{40}$/;
  const ADDRESS_INPUT_RE = /^ZYN[0-9a-fA-F]{40}$/;
  const PUBLIC_KEY_RE = /^[0-9a-f]{128}$/;
  const HEX_RE = /^(?:[0-9a-f]{2})+$/;

  function vendor() {
    const v = root.ZyronVendor;
    if (!v || !v.secp256k1 || !v.bip39 || !v.HDKey) throw new Error('Vendored crypto libraries are not loaded');
    return v;
  }
  function webCrypto() {
    const c = root.crypto;
    if (!c || typeof c.getRandomValues !== 'function' || !c.subtle) throw new Error('This browser does not provide Web Crypto');
    return c;
  }
  const encoder = new TextEncoder();

  function wipe() {
    for (const bytes of arguments) if (bytes && typeof bytes.fill === 'function') bytes.fill(0);
  }
  function randomBytes(length) {
    return webCrypto().getRandomValues(new Uint8Array(length));
  }
  function bytesToHex(bytes) { return vendor().bytesToHex(bytes); }
  function hexToBytes(hex) {
    if (typeof hex !== 'string' || !HEX_RE.test(hex)) throw new Error('Invalid hex');
    return vendor().hexToBytes(hex);
  }
  function sha256Hex(value) {
    const v = vendor();
    return v.bytesToHex(v.sha256(typeof value === 'string' ? encoder.encode(value) : value));
  }

  // ---------- canonical JSON (port of l1/src/codec.ts) ----------
  function normalize(value, depth, ancestors) {
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      if (depth > 64) throw new Error('Canonical JSON nesting depth exceeded');
      if (ancestors.has(value)) throw new Error('Canonical JSON must not contain cycles');
      ancestors.add(value);
      try {
        if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1, ancestors));
        return Object.fromEntries(Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, normalize(item, depth + 1, ancestors)]));
      } finally {
        ancestors.delete(value);
      }
    }
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Consensus numbers must be safe integers');
    return value;
  }
  function canonicalJson(value) { return JSON.stringify(normalize(value, 0, new Set())); }

  // ---------- addresses ----------
  function addressFromPublicKey(publicKeyHex) {
    if (!PUBLIC_KEY_RE.test(publicKeyHex)) throw new Error('Public key must be 128 lower-case hex characters');
    return 'ZYN' + sha256Hex(hexToBytes(publicKeyHex)).slice(0, 40);
  }
  function toChecksumAddress(address) {
    if (typeof address !== 'string' || !ADDRESS_RE.test(address)) throw new Error('Expected a canonical ZYN + 40 lower-case hex address');
    const hash = sha256Hex(ADDRESS_CHECKSUM_DOMAIN + address);
    let out = 'ZYN';
    for (let i = 0; i < 40; i += 1) {
      const c = address[3 + i];
      out += c >= 'a' && c <= 'f' && parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c;
    }
    return out;
  }
  function parseAddressInput(value) {
    const text = String(value == null ? '' : value).trim();
    if (!ADDRESS_INPUT_RE.test(text)) throw new Error('Address must be ZYN followed by exactly 40 hex characters');
    const canonical = 'ZYN' + text.slice(3).toLowerCase();
    const checksummed = toChecksumAddress(canonical);
    const body = text.slice(3);
    if (body === body.toLowerCase()) return { canonical, checksummed, checksumVerified: false };
    if (text !== checksummed) throw new Error('Checksum mismatch: the upper/lower-case pattern is wrong, so the address probably has a typo');
    return { canonical, checksummed, checksumVerified: true };
  }
  function groupAddress(address) {
    return 'ZYN ' + address.slice(3).match(/.{1,4}/g).join(' ');
  }
  // Full checksummed address in 4-character blocks, for every place an address is shown.
  function displayAddress(address) {
    return groupAddress(toChecksumAddress(parseAddressInput(address).canonical));
  }
  // Indices (0..39) of the hex characters that differ between two addresses (case-insensitive).
  function addressDiff(a, b) {
    const x = parseAddressInput(a).canonical.slice(3);
    const y = parseAddressInput(b).canonical.slice(3);
    const out = [];
    for (let i = 0; i < 40; i += 1) if (x[i] !== y[i]) out.push(i);
    return out;
  }

  // ---------- password rule (identical to website/wallet-core.js and l1 password-prompt.ts) ----------
  function passwordStrength(password) {
    const chars = Array.from(password);
    let lower = false; let upper = false; let digit = false; let symbol = false; let other = false;
    for (const char of chars) {
      const code = char.codePointAt(0);
      if (code >= 97 && code <= 122) lower = true;
      else if (code >= 65 && code <= 90) upper = true;
      else if (code >= 48 && code <= 57) digit = true;
      else if (code >= 32 && code <= 126) symbol = true;
      else other = true;
    }
    const pool = (lower ? 26 : 0) + (upper ? 26 : 0) + (digit ? 10 : 0) + (symbol ? 33 : 0) + (other ? 100 : 0);
    const bits = pool > 0 ? Math.floor(chars.length * Math.log2(pool)) : 0;
    const distinct = new Set(chars).size;
    if (chars.length < 12) return { ok: false, bits: bits, reason: 'Password must contain at least 12 characters' };
    if (distinct < 6) return { ok: false, bits: bits, reason: 'Password is too repetitive (fewer than 6 distinct characters)' };
    if (bits < 60) return { ok: false, bits: bits, reason: 'Password is too weak (about ' + bits + ' bits estimated; need 60+). Use a longer passphrase or mix character types' };
    return { ok: true, bits: bits, reason: '' };
  }

  // ---------- BIP-39 / BIP-32 ----------
  function normalizePhrase(text) {
    return String(text == null ? '' : text).normalize('NFKD').toLowerCase().trim().split(/\s+/).filter(Boolean).join(' ');
  }
  function generateEntropy() { return randomBytes(16); } // 128 bits -> 12 words
  function entropyToPhrase(entropy) {
    const v = vendor();
    return v.bip39.entropyToMnemonic(entropy, v.bip39.wordlist);
  }
  function phraseToEntropy(text) {
    const v = vendor();
    const phrase = normalizePhrase(text);
    const count = phrase ? phrase.split(' ').length : 0;
    if (![12, 15, 18, 21, 24].includes(count)) throw new Error('A recovery phrase has 12 (or 15/18/21/24) words; got ' + count);
    const unknown = phrase.split(' ').filter((w) => !v.bip39.wordlist.includes(w));
    if (unknown.length) throw new Error('Not in the BIP-39 English word list: ' + unknown.slice(0, 3).join(', '));
    if (!v.bip39.validateMnemonic(phrase, v.bip39.wordlist)) throw new Error('Recovery phrase checksum is wrong (a word is misspelled or out of order)');
    return v.bip39.mnemonicToEntropy(phrase, v.bip39.wordlist);
  }
  // Returns { privateKey (Uint8Array, caller must wipe), publicKey, address }.
  async function deriveAccount(entropy) {
    const v = vendor();
    if (!(entropy instanceof Uint8Array) || ![16, 20, 24, 28, 32].includes(entropy.length)) throw new Error('Invalid entropy');
    const phrase = v.bip39.entropyToMnemonic(entropy, v.bip39.wordlist);
    const seed = await v.bip39.mnemonicToSeed(phrase, ''); // no BIP-39 passphrase, same as MetaMask
    let node = null;
    try {
      node = v.HDKey.fromMasterSeed(seed).derive(DERIVATION_PATH);
      if (!node.privateKey) throw new Error('Derivation produced no private key');
      const privateKey = Uint8Array.from(node.privateKey);
      const publicKey = v.bytesToHex(v.secp256k1.getPublicKey(privateKey, false).slice(1));
      return { privateKey, publicKey, address: addressFromPublicKey(publicKey) };
    } finally {
      wipe(seed);
      if (node && typeof node.wipePrivateData === 'function') node.wipePrivateData();
    }
  }

  // ---------- vault ----------
  function kdfLabel(kdf) { return 'scrypt:n=' + kdf.n + ',r=' + kdf.r + ',p=' + kdf.p + ',dklen=' + kdf.dkLen; }
  function vaultAad(vault) {
    return encoder.encode(['zyronchain/pwa-vault/v' + vault.version, kdfLabel(vault.kdf), vault.cipher.name, vault.derivationPath, vault.publicKey, vault.address].join('\n'));
  }
  // The book is sealed separately (own IV) so it can be rewritten while unlocked without touching the seed ciphertext.
  function bookAad(vault) {
    return encoder.encode(['zyronchain/pwa-vault/v' + vault.version + '/book', kdfLabel(vault.kdf), vault.cipher.name, vault.salt, vault.cipher.iv, vault.publicKey, vault.address].join('\n'));
  }
  async function deriveVaultKey(password, salt, usage) {
    const v = vendor();
    if (typeof password !== 'string' || !password) throw new Error('Password required');
    const pw = encoder.encode(password.normalize('NFC'));
    let dk = null;
    try {
      dk = await v.scryptAsync(pw, salt, { N: VAULT_KDF.n, r: VAULT_KDF.r, p: VAULT_KDF.p, dkLen: VAULT_KDF.dkLen, maxmem: 256 * VAULT_KDF.n * VAULT_KDF.r });
      return await webCrypto().subtle.importKey('raw', dk, { name: 'AES-GCM' }, false, Array.isArray(usage) ? usage : [usage]);
    } finally {
      wipe(pw, dk);
    }
  }

  // ---------- encrypted book: address book + sent-to history + warning threshold ----------
  function emptyBook() { return { contacts: [], sent: [], thresholdAtoms: null }; }
  function normalizeContactName(name) {
    const text = String(name == null ? '' : name).normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('Contact name is required');
    if (text.length > BOOK_NAME_MAX) throw new Error('Contact name is too long (at most ' + BOOK_NAME_MAX + ' characters)');
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('Contact name has control characters');
    return text;
  }
  // Validates untrusted book data (decrypted plaintext) and returns a fresh normalized copy. Fails closed.
  function parseBook(value) {
    if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== 'contacts,sent,thresholdAtoms') throw new Error('Address book data is invalid');
    if (!Array.isArray(value.contacts) || value.contacts.length > BOOK_MAX_CONTACTS) throw new Error('Address book contacts are invalid');
    if (!Array.isArray(value.sent) || value.sent.length > BOOK_MAX_SENT) throw new Error('Address book history is invalid');
    const seen = new Set();
    const contacts = value.contacts.map((c) => {
      if (!isPlainObject(c) || Object.keys(c).sort().join(',') !== 'address,name') throw new Error('Address book contact is invalid');
      if (typeof c.address !== 'string' || !ADDRESS_RE.test(c.address) || seen.has(c.address)) throw new Error('Address book contact address is invalid');
      seen.add(c.address);
      const name = normalizeContactName(c.name);
      if (name !== c.name) throw new Error('Address book contact name is invalid');
      return { name, address: c.address };
    });
    const sentSeen = new Set();
    const sent = value.sent.map((a) => {
      if (typeof a !== 'string' || !ADDRESS_RE.test(a) || sentSeen.has(a)) throw new Error('Address book history is invalid');
      sentSeen.add(a);
      return a;
    });
    const t = value.thresholdAtoms;
    if (t !== null && !(Number.isSafeInteger(t) && t >= 1 && t <= MAX_SUPPLY_ATOMS)) throw new Error('Send-warning threshold is invalid');
    return { contacts, sent, thresholdAtoms: t };
  }
  function contactAddress(address) { return parseAddressInput(address).canonical; }
  function addContact(book, input) {
    const b = parseBook(book);
    const address = contactAddress(input && input.address);
    const name = normalizeContactName(input && input.name);
    if (address === MINING_TRACKER_ADDRESS) throw new Error("This is a reserved system address and can't receive transfers");
    if (b.contacts.some((c) => c.address === address)) throw new Error('This address is already in the address book');
    if (b.contacts.length >= BOOK_MAX_CONTACTS) throw new Error('The address book is full (' + BOOK_MAX_CONTACTS + ' contacts)');
    b.contacts.push({ name, address });
    return b;
  }
  function updateContact(book, originalAddress, input) {
    const b = parseBook(book);
    const original = contactAddress(originalAddress);
    const index = b.contacts.findIndex((c) => c.address === original);
    if (index < 0) throw new Error('Contact not found');
    const address = contactAddress(input && input.address);
    if (address === MINING_TRACKER_ADDRESS) throw new Error("This is a reserved system address and can't receive transfers");
    if (address !== original && b.contacts.some((c) => c.address === address)) throw new Error('This address is already in the address book');
    b.contacts[index] = { name: normalizeContactName(input && input.name), address };
    return b;
  }
  function removeContact(book, address) {
    const b = parseBook(book);
    const target = contactAddress(address);
    const next = b.contacts.filter((c) => c.address !== target);
    if (next.length === b.contacts.length) throw new Error('Contact not found');
    b.contacts = next;
    return b;
  }
  function findContact(book, address) {
    let canonical;
    try { canonical = contactAddress(address); } catch (error) { return null; }
    const hit = parseBook(book).contacts.find((c) => c.address === canonical);
    return hit || null;
  }
  // Records a signed transfer's receiver (most recent first, bounded, no duplicates).
  function recordSent(book, receiver) {
    const b = parseBook(book);
    const address = contactAddress(receiver);
    b.sent = [address, ...b.sent.filter((a) => a !== address)].slice(0, BOOK_MAX_SENT);
    return b;
  }
  // null clears the threshold; otherwise a positive atom amount.
  function setThreshold(book, atoms) {
    const b = parseBook(book);
    if (atoms !== null && !(Number.isSafeInteger(atoms) && atoms >= 1 && atoms <= MAX_SUPPLY_ATOMS)) throw new Error('Threshold must be at least 1 atom');
    b.thresholdAtoms = atoms;
    return b;
  }
  // Local send-safety checks. input: { receiver, amountAtoms }, account: { address }. Returns a list of
  // { code, blocking, message }. 'self' is blocking because the transfer builder (and l1) reject self-transfers.
  // Known addresses (contacts, then sent history) that look like the receiver but are a different
  // full address. The full 40-character address is always compared: an exact match is never a lookalike.
  function lookalikeMatches(receiverInput, book) {
    const b = parseBook(book);
    const receiver = parseAddressInput(receiverInput).canonical;
    const rx = receiver.slice(3);
    const known = [];
    const seen = new Set();
    for (const c of b.contacts) if (!seen.has(c.address)) { seen.add(c.address); known.push({ address: c.address, name: c.name, source: 'contact' }); }
    for (const a of b.sent) if (!seen.has(a)) { seen.add(a); known.push({ address: a, name: null, source: 'history' }); }
    const checked = known.slice(0, LOOKALIKE_MAX_COMPARISONS);
    const matches = [];
    for (const k of checked) {
      if (k.address === receiver) continue; // exact full match: the receiver is this known address
      const kx = k.address.slice(3);
      let prefix = 0;
      while (prefix < 40 && kx[prefix] === rx[prefix]) prefix += 1;
      let suffix = 0; // bounded by 40 - prefix so no character counts twice
      while (suffix < 40 - prefix && kx[39 - suffix] === rx[39 - suffix]) suffix += 1;
      const ends = prefix + suffix >= LOOKALIKE_MIN_SHARED;
      const diff = [];
      for (let i = 0; i < 40; i += 1) if (kx[i] !== rx[i]) diff.push(i);
      if (diff.length === 0) continue;
      if (ends || diff.length <= LOOKALIKE_MAX_DIFF) {
        matches.push({ address: k.address, name: k.name, source: k.source, diff, prefix, suffix });
        if (matches.length >= LOOKALIKE_MAX_MATCHES) break;
      }
    }
    return { receiver, matches, compared: checked.length, truncated: known.length > checked.length };
  }
  function sendWarnings(input, account, book) {
    const b = parseBook(book);
    const out = [];
    const receiver = contactAddress(input && input.receiver);
    if (account && receiver === contactAddress(account.address)) {
      out.push({ code: 'self', blocking: true, message: SELF_SEND_MESSAGE });
      return out;
    }
    const look = lookalikeMatches(receiver, b);
    if (look.matches.length) {
      const m = look.matches[0];
      out.push({ code: 'lookalike', blocking: false, receiver, matches: look.matches, message:
        'This address looks like ' + (m.source === 'contact' ? 'your saved contact "' + m.name + '"' : 'an address you sent to before') +
        ' but it is a DIFFERENT address. Scammers create lookalike addresses with the same start and end. Compare every character.' });
    }
    const contact = b.contacts.find((c) => c.address === receiver);
    if (!b.sent.includes(receiver)) {
      out.push({ code: 'first-time', blocking: false, message: contact
        ? 'You have not sent to this address from this wallet before (saved contact "' + contact.name + '"). Check every character of the address.'
        : 'You have never sent to this address from this wallet, and it is not in your address book. Check every character of the address.' });
    }
    const amount = input && input.amountAtoms;
    if (b.thresholdAtoms !== null && Number.isSafeInteger(amount) && amount >= b.thresholdAtoms) {
      out.push({ code: 'large-amount', blocking: false, message: 'The amount (' + atomsToZyn(String(amount)) + ' ZYN) is at or above your warning threshold of ' + atomsToZyn(String(b.thresholdAtoms)) + ' ZYN.' });
    }
    return out;
  }
  async function sealBook(vault, key, book) {
    const plain = encoder.encode(canonicalJson(parseBook(book)));
    if (plain.length > BOOK_MAX_PLAINTEXT) throw new Error('Address book is too large');
    const iv = randomBytes(12);
    const sealed = new Uint8Array(await webCrypto().subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bookAad(vault), tagLength: 128 }, key, plain));
    wipe(plain);
    return { iv: bytesToHex(iv), ciphertext: bytesToHex(sealed) };
  }
  async function openBook(vault, key) {
    let plain;
    try {
      plain = new Uint8Array(await webCrypto().subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(vault.book.iv), additionalData: bookAad(vault), tagLength: 128 }, key, hexToBytes(vault.book.ciphertext)));
    } catch (error) {
      throw new Error('Wrong password, or the vault was modified (authentication failed)');
    }
    let value;
    try { value = JSON.parse(new TextDecoder().decode(plain)); } catch (error) { throw new Error('Address book data is invalid'); } finally { wipe(plain); }
    return parseBook(value);
  }
  // Seals entropy (+ book) into a fresh v2 vault object with the given key/salt.
  async function sealVault(entropy, key, salt, account, createdAt, words, book) {
    const iv = randomBytes(12);
    const vault = {
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      createdAt,
      address: account.address,
      publicKey: account.publicKey,
      derivationPath: DERIVATION_PATH,
      words,
      kdf: { name: VAULT_KDF.name, n: VAULT_KDF.n, r: VAULT_KDF.r, p: VAULT_KDF.p, dkLen: VAULT_KDF.dkLen },
      cipher: { name: VAULT_CIPHER, iv: bytesToHex(iv) },
      salt: bytesToHex(salt),
      ciphertext: '',
      book: { iv: '', ciphertext: '' }
    };
    const sealed = new Uint8Array(await webCrypto().subtle.encrypt({ name: 'AES-GCM', iv, additionalData: vaultAad(vault), tagLength: 128 }, key, entropy));
    vault.ciphertext = bytesToHex(sealed);
    vault.book = await sealBook(vault, key, book || emptyBook());
    return vault;
  }
  // Returns { vault, key, book }: key is a non-extractable AES-GCM key kept by the app while unlocked so the
  // encrypted book can be re-sealed without asking for the password again.
  async function createVaultSession(entropy, password, account, now, book) {
    const strength = passwordStrength(password);
    if (!strength.ok) throw new Error(strength.reason);
    if (!account || !ADDRESS_RE.test(account.address) || !PUBLIC_KEY_RE.test(account.publicKey)) throw new Error('Invalid account');
    const salt = randomBytes(16);
    const key = await deriveVaultKey(password, salt, ['encrypt', 'decrypt']);
    const initial = parseBook(book || emptyBook());
    const vault = await sealVault(entropy, key, salt, account, new Date(now == null ? Date.now() : now).toISOString(), entropy.length * 3 / 4, initial);
    return { vault, key, book: initial };
  }
  async function createVault(entropy, password, account, now, book) {
    return (await createVaultSession(entropy, password, account, now, book)).vault;
  }
  // Fail closed: anything that is not exactly a version-1 or version-2 vault written by this app is rejected before
  // any decryption is attempted. Unknown versions are never "best-effort" parsed.
  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  function assertVaultShape(vault) {
    if (!isPlainObject(vault)) throw new Error('Vault is not a plain object');
    const known = vault.version === VAULT_VERSION || vault.version === VAULT_VERSION_V1;
    const keys = Object.keys(vault).sort();
    const expected = vault.version === VAULT_VERSION_V1 ? VAULT_KEYS_V1 : VAULT_KEYS;
    if (keys.join(',') !== expected.join(',')) throw new Error('Vault has unexpected fields');
    if (vault.format !== VAULT_FORMAT) throw new Error('Unsupported vault format');
    if (typeof vault.version !== 'number' || !known) throw new Error('Unsupported vault version (this app reads versions ' + VAULT_VERSION_V1 + ' and ' + VAULT_VERSION + '); nothing was changed');
    if (typeof vault.createdAt !== 'string' || !ISO_UTC_RE.test(vault.createdAt) || !Number.isFinite(Date.parse(vault.createdAt))) throw new Error('Vault creation time is invalid');
    const k = vault.kdf;
    if (!isPlainObject(k) || Object.keys(k).sort().join(',') !== 'dkLen,n,name,p,r' ||
        k.name !== VAULT_KDF.name || k.n !== VAULT_KDF.n || k.r !== VAULT_KDF.r || k.p !== VAULT_KDF.p || k.dkLen !== VAULT_KDF.dkLen) {
      throw new Error('Vault KDF parameters are not the supported scrypt N=2^17, r=8, p=1 set');
    }
    if (!isPlainObject(vault.cipher) || Object.keys(vault.cipher).sort().join(',') !== 'iv,name' || vault.cipher.name !== VAULT_CIPHER || !/^[0-9a-f]{24}$/.test(vault.cipher.iv)) throw new Error('Vault cipher is invalid');
    if (!/^[0-9a-f]{32}$/.test(vault.salt)) throw new Error('Vault salt is invalid');
    if (vault.derivationPath !== DERIVATION_PATH) throw new Error('Vault derivation path is not supported');
    if (typeof vault.words !== 'number' || ![12, 15, 18, 21, 24].includes(vault.words)) throw new Error('Vault word count is invalid');
    if (!ADDRESS_RE.test(vault.address) || !PUBLIC_KEY_RE.test(vault.publicKey) || addressFromPublicKey(vault.publicKey) !== vault.address) throw new Error('Vault identity is invalid');
    if (typeof vault.ciphertext !== 'string' || !HEX_RE.test(vault.ciphertext) || vault.ciphertext.length !== (vault.words * 4 / 3 + 16) * 2) throw new Error('Vault ciphertext is invalid');
    if (vault.version === VAULT_VERSION) {
      const b = vault.book;
      if (!isPlainObject(b) || Object.keys(b).sort().join(',') !== 'ciphertext,iv' || !/^[0-9a-f]{24}$/.test(b.iv) ||
          typeof b.ciphertext !== 'string' || !HEX_RE.test(b.ciphertext) || b.ciphertext.length < 34 || b.ciphertext.length % 2 !== 0 ||
          b.ciphertext.length > (BOOK_MAX_PLAINTEXT + 16) * 2) throw new Error('Vault address book is invalid');
      if (b.iv === vault.cipher.iv) throw new Error('Vault address book is invalid');
    }
  }
  // Parses an untrusted stored value (IndexedDB record or JSON text) into a fresh vault object containing only the
  // known fields. Throws (fail closed) on anything else.
  function parseVault(raw) {
    let value = raw;
    if (typeof raw === 'string') {
      if (raw.length > MAX_VAULT_TEXT) throw new Error('Vault is too large');
      try { value = JSON.parse(raw); } catch (error) { throw new Error('Vault is not valid JSON'); }
    }
    assertVaultShape(value);
    const out = {
      format: value.format, version: value.version, createdAt: value.createdAt, address: value.address, publicKey: value.publicKey,
      derivationPath: value.derivationPath, words: value.words,
      kdf: { name: value.kdf.name, n: value.kdf.n, r: value.kdf.r, p: value.kdf.p, dkLen: value.kdf.dkLen },
      cipher: { name: value.cipher.name, iv: value.cipher.iv }, salt: value.salt, ciphertext: value.ciphertext
    };
    if (value.version === VAULT_VERSION) out.book = { iv: value.book.iv, ciphertext: value.book.ciphertext };
    return out;
  }
  // Returns { entropy, account, book, key } — caller must wipe entropy and account.privateKey, and drop key on lock.
  // book is the decrypted address book (an empty book for a version-1 vault). key is a non-extractable AES-GCM key
  // used to re-seal the book while unlocked (sealBook / upgradeVault).
  async function openVault(vault, password) {
    assertVaultShape(vault);
    const key = await deriveVaultKey(password, hexToBytes(vault.salt), ['encrypt', 'decrypt']);
    let entropy;
    try {
      entropy = new Uint8Array(await webCrypto().subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(vault.cipher.iv), additionalData: vaultAad(vault), tagLength: 128 }, key, hexToBytes(vault.ciphertext)));
    } catch (error) {
      throw new Error('Wrong password, or the vault was modified (authentication failed)');
    }
    const account = await deriveAccount(entropy);
    if (account.address !== vault.address || account.publicKey !== vault.publicKey) {
      wipe(entropy, account.privateKey);
      throw new Error('Vault decrypted to a different identity');
    }
    let book;
    try {
      book = vault.version === VAULT_VERSION ? await openBook(vault, key) : emptyBook();
    } catch (error) {
      wipe(entropy, account.privateKey);
      throw error;
    }
    return { entropy, account, book, key };
  }
  // Version 1 -> 2 upgrade, run only after openVault succeeded (so the password was right and the seed decrypted).
  // Keeps salt, identity, createdAt and the seed; re-seals the seed under the v2 AAD with a fresh IV and adds the
  // encrypted book. The input vault is not modified. A version-2 vault is returned unchanged (copied).
  async function upgradeVault(vault, opened) {
    assertVaultShape(vault);
    if (vault.version === VAULT_VERSION) return parseVault(vault);
    if (!opened || !opened.entropy || !opened.key || !opened.account || opened.account.address !== vault.address) throw new Error('Unlock the vault before upgrading it');
    const next = await sealVault(opened.entropy, opened.key, hexToBytes(vault.salt), opened.account, vault.createdAt, vault.words, opened.book || emptyBook());
    assertVaultShape(next);
    return next;
  }
  // Upgrade + proof: the new vault must open with the same password and give the same identity and seed before
  // the caller may store it. Returns { vault, opened } (opened is the session from the v2 vault; caller wipes it).
  async function upgradeVaultVerified(vault, opened, password) {
    const next = await upgradeVault(vault, opened);
    const check = await openVault(next, password);
    const same = check.account.address === vault.address && check.account.publicKey === vault.publicKey &&
      check.entropy.length === opened.entropy.length && check.entropy.every((b, i) => b === opened.entropy[i]);
    if (!same) {
      wipe(check.entropy, check.account.privateKey);
      throw new Error('Vault upgrade check failed: the upgraded vault did not reopen to the same wallet; nothing was changed');
    }
    wipe(check.entropy);
    return { vault: next, opened: check };
  }
  // Rollback marker: a small public record saying this device has opened a version-2 vault for this address.
  const UPGRADE_MARKER_FORMAT = 'zyronchain-pwa-vault-v2-seen';
  function upgradeMarker(address) {
    if (!ADDRESS_RE.test(address)) throw new Error('Invalid address');
    return { format: UPGRADE_MARKER_FORMAT, version: VAULT_VERSION, address };
  }
  function parseUpgradeMarker(value) {
    if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== 'address,format,version' ||
        value.format !== UPGRADE_MARKER_FORMAT || value.version !== VAULT_VERSION || !ADDRESS_RE.test(value.address)) throw new Error('Upgrade marker is invalid');
    return upgradeMarker(value.address);
  }
  // True when a version-1 vault must be refused because a version-2 vault for the same address was already seen.
  function isRollback(vault, marker) {
    return Boolean(marker) && vault && vault.version === VAULT_VERSION_V1 && parseUpgradeMarker(marker).address === vault.address;
  }
  // Returns a copy of a version-2 vault with the book re-sealed (fresh IV). Needs the key from openVault.
  async function updateVaultBook(vault, key, book) {
    const current = parseVault(vault);
    if (current.version !== VAULT_VERSION) throw new Error('Upgrade the vault before saving the address book');
    current.book = await sealBook(current, key, book);
    assertVaultShape(current);
    return current;
  }

  // ---------- amounts ----------
  function zynToAtoms(value) {
    const text = String(value == null ? '' : value).trim().replace(/_/g, '');
    if (/^\d{10,}(?:\.\d*)?$/.test(text)) throw new Error('Amount is too large: the total supply is 50,000,000 ZYN');
    const match = /^(\d{1,9})(?:\.(\d{1,8}))?$/.exec(text);
    if (!match) throw new Error('Use a plain decimal ZYN amount with at most 8 decimal places, e.g. 1.5');
    const atoms = Number(match[1]) * ATOMS_PER_ZYN + Number((match[2] || '').padEnd(8, '0') || '0');
    if (!Number.isSafeInteger(atoms) || atoms > MAX_SUPPLY_ATOMS) throw new Error('Amount is too large: the total supply is 50,000,000 ZYN');
    return atoms;
  }
  function atomsToZyn(value) {
    const text = String(value == null ? '' : value).trim().replace(/_/g, '');
    if (!/^\d{1,16}$/.test(text)) throw new Error('Atoms must be a whole number');
    const atoms = Number(text);
    if (!Number.isSafeInteger(atoms) || atoms > MAX_SUPPLY_ATOMS) throw new Error('Amount exceeds the 50,000,000 ZYN fixed-supply design');
    const whole = Math.floor(atoms / ATOMS_PER_ZYN);
    const fraction = String(atoms % ATOMS_PER_ZYN).padStart(8, '0').replace(/0+$/, '');
    return fraction ? whole + '.' + fraction : String(whole);
  }

  // ---------- transfers (port of l1 createTransfer / Snap transfer.ts) ----------
  function signCanonical(payload, privateKey) {
    const v = vendor();
    return v.bytesToHex(v.secp256k1.sign(encoder.encode(canonicalJson(payload)), privateKey, { format: 'compact', prehash: true, lowS: true, extraEntropy: false }));
  }
  function verifyCanonical(payload, signatureHex, publicKeyHex) {
    const v = vendor();
    try {
      return v.secp256k1.verify(hexToBytes(signatureHex), encoder.encode(canonicalJson(payload)), hexToBytes('04' + publicKeyHex), { format: 'compact', prehash: true, lowS: true });
    } catch (error) {
      return false;
    }
  }
  // Builds the ONLY transaction kind this wallet can sign. There is deliberately no `kind` input.
  function buildTransfer(input, account) {
    if (!input || typeof input !== 'object') throw new Error('Missing transfer input');
    const version = Number(input.version);
    if (version !== 1 && version !== 2) throw new Error('Transaction version must be 1 or 2 (protocol 3+ requires 2)');
    const chainId = String(input.chainId == null ? '' : input.chainId).trim();
    if (!CHAIN_ID_RE.test(chainId)) throw new Error('Chain ID must match ^[a-z0-9-]{3,64}$ (copy it from the network announcement)');
    if (!TEST_CHAIN_ID_RE.test(chainId)) throw new Error('This unaudited wallet signs only testnet or devnet chain IDs. The no-value wallet testnet id is ' + WALLET_TESTNET_CHAIN_ID);
    const nonce = typeof input.nonce === 'number' ? input.nonce : Number(String(input.nonce == null ? '' : input.nonce).trim() || NaN);
    if (!Number.isSafeInteger(nonce) || nonce < 1) throw new Error('Nonce must be a whole number >= 1 (your next account nonce)');
    const receiver = parseAddressInput(input.receiver).canonical;
    if (receiver === MINING_TRACKER_ADDRESS) throw new Error("This is a reserved system address and can't receive transfers");
    if (!account || !ADDRESS_RE.test(account.address) || !PUBLIC_KEY_RE.test(account.publicKey)) throw new Error('Wallet is locked');
    if (receiver === account.address) throw new Error(SELF_SEND_MESSAGE);
    const amountAtoms = input.amountAtoms;
    const feeAtoms = input.feeAtoms;
    if (!Number.isSafeInteger(amountAtoms) || amountAtoms < 1 || amountAtoms > MAX_SUPPLY_ATOMS) throw new Error('Amount must be at least 1 atom');
    if (!Number.isSafeInteger(feeAtoms) || feeAtoms < 0 || feeAtoms > MAX_SUPPLY_ATOMS) throw new Error('Fee must be 0 or more atoms');
    if (amountAtoms + feeAtoms > MAX_SUPPLY_ATOMS) throw new Error('Amount + fee exceeds the 50,000,000 ZYN supply');
    const timestampMs = input.timestampMs == null ? Date.now() : input.timestampMs;
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) throw new Error('Invalid timestamp');
    return { kind: 'transfer', version, chainId, nonce, sender: account.address, receiver, amountAtoms, feeAtoms, timestampMs, publicKey: account.publicKey };
  }
  function signTransfer(unsigned, privateKey) {
    if (!unsigned || unsigned.kind !== 'transfer') throw new Error('This wallet signs transfers only');
    describeTransfer(unsigned); // same strict shape check the review screen uses
    const rejection = fixedFeeRejection(unsigned);
    if (rejection) throw new Error(rejection);
    const v = vendor();
    if (v.bytesToHex(v.secp256k1.getPublicKey(privateKey, false).slice(1)) !== unsigned.publicKey) throw new Error('Key does not match the transfer public key');
    const domainPayload = unsigned.version === 2 ? { domain: TRANSFER_SIGNING_DOMAIN_V2, payload: unsigned } : unsigned;
    const signature = signCanonical(domainPayload, privateKey);
    if (!verifyCanonical(domainPayload, signature, unsigned.publicKey)) throw new Error('Internal error: signature failed self-verification');
    const withSignature = Object.assign({}, unsigned, { signature });
    return Object.assign({}, withSignature, { txid: sha256Hex(canonicalJson(withSignature)) });
  }

  const TRANSFER_KEYS = 'amountAtoms,chainId,feeAtoms,kind,nonce,publicKey,receiver,sender,timestampMs,version';
  // Review rows for an UNSIGNED transfer. Refuses anything that is not exactly the supported transfer shape, so the
  // UI can never show (or be tricked into signing) another transaction kind, a message, or arbitrary JSON.
  function describeTransfer(unsigned) {
    if (!isPlainObject(unsigned)) throw new Error('Nothing to review');
    if (unsigned.kind !== 'transfer') throw new Error('Unsupported transaction type: this wallet signs transfers only');
    if (Object.keys(unsigned).sort().join(',') !== TRANSFER_KEYS) throw new Error('Unexpected transfer fields');
    if (unsigned.version !== 1 && unsigned.version !== 2) throw new Error('Unsupported transfer version');
    if (!CHAIN_ID_RE.test(unsigned.chainId)) throw new Error('Chain ID is missing or invalid');
    if (!TEST_CHAIN_ID_RE.test(unsigned.chainId)) throw new Error('Chain ID must name a testnet or devnet network');
    if (!Number.isSafeInteger(unsigned.nonce) || unsigned.nonce < 1) throw new Error('Nonce is missing or invalid');
    if (!ADDRESS_RE.test(unsigned.sender) || !ADDRESS_RE.test(unsigned.receiver)) throw new Error('Address is invalid');
    if (unsigned.receiver === MINING_TRACKER_ADDRESS) throw new Error("This is a reserved system address and can't receive transfers");
    if (!Number.isSafeInteger(unsigned.amountAtoms) || unsigned.amountAtoms < 1 || !Number.isSafeInteger(unsigned.feeAtoms) || unsigned.feeAtoms < 0) throw new Error('Amount or fee is invalid');
    if (!PUBLIC_KEY_RE.test(unsigned.publicKey) || addressFromPublicKey(unsigned.publicKey) !== unsigned.sender) throw new Error('Sender does not match the signing key');
    return [
      { key: 'type', label: 'Type', value: 'Transfer (kind "transfer", version ' + unsigned.version + ')' },
      { key: 'from', label: 'From', value: toChecksumAddress(unsigned.sender) },
      { key: 'to', label: 'To', value: toChecksumAddress(unsigned.receiver) },
      { key: 'amount', label: 'Amount', value: atomsToZyn(String(unsigned.amountAtoms)) + ' ZYN (' + unsigned.amountAtoms + ' atoms)' },
      { key: 'fee', label: 'Fee', value: atomsToZyn(String(unsigned.feeAtoms)) + ' ZYN (' + unsigned.feeAtoms + ' atoms)' },
      { key: 'total', label: 'Total', value: atomsToZyn(String(unsigned.amountAtoms + unsigned.feeAtoms)) + ' ZYN (' + (unsigned.amountAtoms + unsigned.feeAtoms) + ' atoms)' },
      { key: 'chain', label: 'Chain ID', value: unsigned.chainId },
      { key: 'nonce', label: 'Nonce', value: String(unsigned.nonce) },
      { key: 'time', label: 'Timestamp', value: new Date(unsigned.timestampMs).toISOString() }
    ];
  }

  // ---------- game wallet link (ZYRON NODE, testnet) ----------
  // Signs only the exact server template below, so a link request can never carry arbitrary text or a transaction.
  // Signature: l1 signCanonical over canonicalJson({ domain: LINK_SIGNING_DOMAIN, payload: { message } }).
  // The proof holds the nonce, the public key and the signature only; never a key or a recovery phrase.
  const LINK_SIGNING_DOMAIN = 'zyronchain/game/wallet-link/v1';
  const LINK_NETWORK = 'zyron-wallet-testnet-1';
  const LINK_RETURN_URL = 'https://t.me/ZyronNodeBot';
  const LINK_MESSAGE_RE = new RegExp('^ZYRON NODE wallet link \\(TESTNET\\)\\nTelegram user: ([1-9][0-9]{0,15})\\nNetwork: ' + LINK_NETWORK +
    '\\nNonce: ([0-9a-f]{32})\\nIssued: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z)\\nExpires: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z)' +
    '\\nSigning proves you hold this testnet address\\. It is not a transaction: it moves no funds,\\ngrants no tokens and cannot be used on-chain\\.$');
  function base64UrlToText(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,1400}$/.test(value)) throw new Error('Link request is malformed');
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  }
  function textToBase64Url(text) {
    let binary = '';
    for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function parseLinkMessage(message, nowMs) {
    const match = typeof message === 'string' ? LINK_MESSAGE_RE.exec(message) : null;
    if (!match) throw new Error('This is not a ZYRON NODE wallet link request. Nothing was signed.');
    const issuedMs = Date.parse(match[3]);
    const expiresMs = Date.parse(match[4]);
    if (!(expiresMs > issuedMs) || expiresMs - issuedMs > 30 * 60 * 1000) throw new Error('Link request has an invalid validity window');
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    if (now >= expiresMs) throw new Error('This link request expired. Start Connect wallet again in ZYRON NODE.');
    return { message, telegramUser: match[1], network: LINK_NETWORK, nonce: match[2], issued: match[3], expires: match[4], expiresMs };
  }
  // Accepts a location hash like "#link=<base64url(message)>".
  function parseLinkHash(hash, nowMs) {
    const match = /^#link=([A-Za-z0-9_-]+)$/.exec(String(hash || ''));
    if (!match) return null;
    return parseLinkMessage(base64UrlToText(match[1]), nowMs);
  }
  function signLinkProof(request, account, nowMs) {
    const checked = parseLinkMessage(request.message, nowMs); // re-check right before signing
    if (!PUBLIC_KEY_RE.test(account.publicKey) || addressFromPublicKey(account.publicKey) !== account.address) throw new Error('Account key does not match its address');
    const signature = signCanonical({ domain: LINK_SIGNING_DOMAIN, payload: { message: checked.message } }, account.privateKey);
    return { proof: 'zyronlink1.' + checked.nonce + '.' + account.publicKey + '.' + signature, address: account.address, signature };
  }

  // Refuse to run when the vendored crypto is missing, incomplete or produces wrong results.
  const SELF_TEST = { phrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', address: 'ZYN16623f437e90cb7216ce70746f642717cc8b531f' };
  async function selfTest() {
    const v = vendor();
    webCrypto();
    for (const name of ['sha256', 'scryptAsync', 'bytesToHex', 'hexToBytes']) if (typeof v[name] !== 'function') throw new Error('Vendored crypto is incomplete: ' + name);
    if (!v.bip39.wordlist || v.bip39.wordlist.length !== 2048) throw new Error('BIP-39 word list is missing');
    if (sha256Hex('abc') !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') throw new Error('SHA-256 self-test failed');
    const entropy = phraseToEntropy(SELF_TEST.phrase);
    const account = await deriveAccount(entropy);
    wipe(entropy, account.privateKey);
    if (account.address !== SELF_TEST.address) throw new Error('Key derivation self-test failed');
    return true;
  }

  // Callers run this before sendWarnings: a malformed own address makes sendWarnings throw (fail closed,
  // #1143), and the user needs a message about their own wallet, not about the receiver they typed.
  const OWN_ADDRESS_INVALID_MESSAGE = "This wallet's own address could not be read, so the send-safety checks cannot run and nothing was signed. Lock the wallet and unlock it again. If this keeps happening, restore the wallet from your recovery phrase.";
  function assertOwnAccount(account) {
    try { parseAddressInput(account && account.address); } catch (_) { throw new Error(OWN_ADDRESS_INVALID_MESSAGE); }
    return account;
  }

  const api = Object.freeze({
    DERIVATION_PATH, VAULT_FORMAT, VAULT_VERSION, VAULT_VERSION_V1, SELF_SEND_MESSAGE, VAULT_KDF, MAX_VAULT_TEXT, BOOK_MAX_CONTACTS, BOOK_MAX_SENT, BOOK_NAME_MAX, LOOKALIKE_MIN_SHARED, LOOKALIKE_MAX_DIFF, LOOKALIKE_MAX_COMPARISONS, LOOKALIKE_MAX_MATCHES, ATOMS_PER_ZYN, FIXED_TRANSFER_FEE_ATOMS, FIXED_SUPPLY_V1_CHAIN_IDS, MAX_SUPPLY_ATOMS, MINING_TRACKER_ADDRESS,
    TRANSFER_SIGNING_DOMAIN_V2, ADDRESS_CHECKSUM_DOMAIN, ADDRESS_RE, TEST_CHAIN_ID_RE, WALLET_TESTNET_CHAIN_ID, defaultTransferVersion,
    wipe, canonicalJson, sha256Hex, addressFromPublicKey, toChecksumAddress, parseAddressInput, groupAddress, displayAddress, addressDiff,
    passwordStrength, normalizePhrase, generateEntropy, entropyToPhrase, phraseToEntropy, deriveAccount,
    createVault, createVaultSession, openVault, upgradeVaultVerified, upgradeMarker, parseUpgradeMarker, isRollback, assertVaultShape, parseVault, upgradeVault, updateVaultBook,
    emptyBook, parseBook, addContact, updateContact, removeContact, findContact, recordSent, setThreshold, lookalikeMatches, sendWarnings, OWN_ADDRESS_INVALID_MESSAGE, assertOwnAccount, zynToAtoms, atomsToZyn, buildTransfer, describeTransfer, fixedFeeRejection, signTransfer, verifyCanonical,
    LINK_SIGNING_DOMAIN, LINK_NETWORK, LINK_RETURN_URL, parseLinkMessage, parseLinkHash, signLinkProof, textToBase64Url,
    selfTest
  });
  root.ZyronAppCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

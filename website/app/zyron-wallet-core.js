/*
 * ZyronChain PWA wallet core (TESTNET / UNAUDITED).
 *
 * Pure logic used by website/app/app.js and by the Node tests:
 *   - BIP-39 phrase -> BIP-32 m/44'/249249'/0'/0/0 -> secp256k1 key (same path as the MetaMask Snap, PR #922)
 *   - ZyronChain address = "ZYN" + first 40 hex of SHA-256(64-byte uncompressed public key) (l1/src/crypto.ts)
 *   - display-only checksum (docs/ADDRESS_CHECKSUM.md)
 *   - encrypted vault: scrypt(N=2^17, r=8, p=1) + AES-256-GCM, AAD binds version, KDF params, path, public key, address
 *   - offline l1 `transfer` signing, byte-identical to l1 createTransfer (only `transfer`; mining_claim is impossible)
 *
 * Needs globalThis.ZyronVendor (website/app/vendor/noble-scure.js) and Web Crypto (getRandomValues, subtle AES-GCM).
 * This file never performs network I/O and never touches storage.
 */
(function (root) {
  'use strict';

  const DERIVATION_PATH = "m/44'/249249'/0'/0/0";
  const VAULT_FORMAT = 'zyronchain-pwa-vault';
  const VAULT_VERSION = 1;
  const VAULT_KDF = Object.freeze({ name: 'scrypt', n: 131072, r: 8, p: 1, dkLen: 32 });
  const VAULT_CIPHER = 'aes-256-gcm';
  const VAULT_KEYS = ['address', 'cipher', 'ciphertext', 'createdAt', 'derivationPath', 'format', 'kdf', 'publicKey', 'salt', 'version', 'words'];
  const ATOMS_PER_ZYN = 100000000;
  const MAX_SUPPLY_ATOMS = 50000000 * ATOMS_PER_ZYN;
  const MINING_TRACKER_ADDRESS = 'ZYN' + '0'.repeat(40);
  const TRANSFER_SIGNING_DOMAIN_V2 = 'zyronchain/transaction/transfer/v2';
  const ADDRESS_CHECKSUM_DOMAIN = 'zyronchain/address-checksum/v1:';
  const CHAIN_ID_RE = /^[a-z0-9-]{3,64}$/;
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
  async function deriveVaultKey(password, salt, usage) {
    const v = vendor();
    if (typeof password !== 'string' || !password) throw new Error('Password required');
    const pw = encoder.encode(password.normalize('NFC'));
    let dk = null;
    try {
      dk = await v.scryptAsync(pw, salt, { N: VAULT_KDF.n, r: VAULT_KDF.r, p: VAULT_KDF.p, dkLen: VAULT_KDF.dkLen, maxmem: 256 * VAULT_KDF.n * VAULT_KDF.r });
      return await webCrypto().subtle.importKey('raw', dk, { name: 'AES-GCM' }, false, [usage]);
    } finally {
      wipe(pw, dk);
    }
  }
  async function createVault(entropy, password, account, now) {
    const strength = passwordStrength(password);
    if (!strength.ok) throw new Error(strength.reason);
    if (!account || !ADDRESS_RE.test(account.address) || !PUBLIC_KEY_RE.test(account.publicKey)) throw new Error('Invalid account');
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const vault = {
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      createdAt: new Date(now == null ? Date.now() : now).toISOString(),
      address: account.address,
      publicKey: account.publicKey,
      derivationPath: DERIVATION_PATH,
      words: entropy.length * 3 / 4,
      kdf: { name: VAULT_KDF.name, n: VAULT_KDF.n, r: VAULT_KDF.r, p: VAULT_KDF.p, dkLen: VAULT_KDF.dkLen },
      cipher: { name: VAULT_CIPHER, iv: bytesToHex(iv) },
      salt: bytesToHex(salt),
      ciphertext: ''
    };
    const key = await deriveVaultKey(password, salt, 'encrypt');
    const sealed = new Uint8Array(await webCrypto().subtle.encrypt({ name: 'AES-GCM', iv, additionalData: vaultAad(vault), tagLength: 128 }, key, entropy));
    vault.ciphertext = bytesToHex(sealed);
    return vault;
  }
  // Fail closed: anything that is not exactly a version-1 vault written by this app is rejected before any
  // decryption is attempted. Unknown versions are never "best-effort" parsed or migrated.
  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  function assertVaultShape(vault) {
    if (!isPlainObject(vault)) throw new Error('Vault is not a plain object');
    const keys = Object.keys(vault).sort();
    if (keys.join(',') !== VAULT_KEYS.join(',')) throw new Error('Vault has unexpected fields');
    if (vault.format !== VAULT_FORMAT) throw new Error('Unsupported vault format');
    if (typeof vault.version !== 'number' || vault.version !== VAULT_VERSION) throw new Error('Unsupported vault version (this app reads only version ' + VAULT_VERSION + '); nothing was changed');
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
  }
  // Parses an untrusted stored value (IndexedDB record or JSON text) into a fresh vault object containing only the
  // known fields. Throws (fail closed) on anything else.
  function parseVault(raw) {
    let value = raw;
    if (typeof raw === 'string') {
      if (raw.length > 4096) throw new Error('Vault is too large');
      try { value = JSON.parse(raw); } catch (error) { throw new Error('Vault is not valid JSON'); }
    }
    assertVaultShape(value);
    return {
      format: value.format, version: value.version, createdAt: value.createdAt, address: value.address, publicKey: value.publicKey,
      derivationPath: value.derivationPath, words: value.words,
      kdf: { name: value.kdf.name, n: value.kdf.n, r: value.kdf.r, p: value.kdf.p, dkLen: value.kdf.dkLen },
      cipher: { name: value.cipher.name, iv: value.cipher.iv }, salt: value.salt, ciphertext: value.ciphertext
    };
  }
  // Returns { entropy, account } — caller must wipe entropy and account.privateKey.
  async function openVault(vault, password) {
    assertVaultShape(vault);
    const key = await deriveVaultKey(password, hexToBytes(vault.salt), 'decrypt');
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
    return { entropy, account };
  }

  // ---------- amounts ----------
  function zynToAtoms(value) {
    const text = String(value == null ? '' : value).trim().replace(/_/g, '');
    const match = /^(\d{1,9})(?:\.(\d{1,8}))?$/.exec(text);
    if (!match) throw new Error('Use a plain decimal ZYN amount with at most 8 decimal places, e.g. 1.5');
    const atoms = Number(match[1]) * ATOMS_PER_ZYN + Number((match[2] || '').padEnd(8, '0') || '0');
    if (!Number.isSafeInteger(atoms) || atoms > MAX_SUPPLY_ATOMS) throw new Error('Amount exceeds the 50,000,000 ZYN fixed-supply design');
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
    const nonce = typeof input.nonce === 'number' ? input.nonce : Number(String(input.nonce == null ? '' : input.nonce).trim() || NaN);
    if (!Number.isSafeInteger(nonce) || nonce < 1) throw new Error('Nonce must be a whole number >= 1 (your next account nonce)');
    const receiver = parseAddressInput(input.receiver).canonical;
    if (receiver === MINING_TRACKER_ADDRESS) throw new Error('Receiver is the protocol-reserved mining tracker address');
    if (!account || !ADDRESS_RE.test(account.address) || !PUBLIC_KEY_RE.test(account.publicKey)) throw new Error('Wallet is locked');
    if (receiver === account.address) throw new Error('Receiver must differ from your own address');
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
    if (!Number.isSafeInteger(unsigned.nonce) || unsigned.nonce < 1) throw new Error('Nonce is missing or invalid');
    if (!ADDRESS_RE.test(unsigned.sender) || !ADDRESS_RE.test(unsigned.receiver)) throw new Error('Address is invalid');
    if (unsigned.receiver === MINING_TRACKER_ADDRESS) throw new Error('Receiver is the protocol-reserved mining tracker address');
    if (!Number.isSafeInteger(unsigned.amountAtoms) || unsigned.amountAtoms < 1 || !Number.isSafeInteger(unsigned.feeAtoms) || unsigned.feeAtoms < 0) throw new Error('Amount or fee is invalid');
    if (!PUBLIC_KEY_RE.test(unsigned.publicKey) || addressFromPublicKey(unsigned.publicKey) !== unsigned.sender) throw new Error('Sender does not match the signing key');
    return [
      { key: 'type', label: 'Type', value: 'Transfer (kind "transfer", version ' + unsigned.version + ')' },
      { key: 'from', label: 'From', value: toChecksumAddress(unsigned.sender) },
      { key: 'to', label: 'To', value: toChecksumAddress(unsigned.receiver) },
      { key: 'amount', label: 'Amount', value: atomsToZyn(String(unsigned.amountAtoms)) + ' ZYN (' + unsigned.amountAtoms + ' atoms)' },
      { key: 'fee', label: 'Fee', value: atomsToZyn(String(unsigned.feeAtoms)) + ' ZYN (' + unsigned.feeAtoms + ' atoms)' },
      { key: 'chain', label: 'Chain ID', value: unsigned.chainId },
      { key: 'nonce', label: 'Nonce', value: String(unsigned.nonce) },
      { key: 'time', label: 'Timestamp', value: new Date(unsigned.timestampMs).toISOString() }
    ];
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

  const api = Object.freeze({
    DERIVATION_PATH, VAULT_FORMAT, VAULT_VERSION, VAULT_KDF, ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, MINING_TRACKER_ADDRESS,
    TRANSFER_SIGNING_DOMAIN_V2, ADDRESS_CHECKSUM_DOMAIN, ADDRESS_RE,
    wipe, canonicalJson, sha256Hex, addressFromPublicKey, toChecksumAddress, parseAddressInput, groupAddress,
    passwordStrength, normalizePhrase, generateEntropy, entropyToPhrase, phraseToEntropy, deriveAccount,
    createVault, openVault, assertVaultShape, parseVault, zynToAtoms, atomsToZyn, buildTransfer, describeTransfer, signTransfer, verifyCanonical,
    selfTest
  });
  root.ZyronAppCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

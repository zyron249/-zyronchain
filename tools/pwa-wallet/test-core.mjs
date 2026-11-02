#!/usr/bin/env node
// Node tests for website/app (ZyronChain PWA wallet): derivation vectors (Snap + independent BIP-32 + l1),
// vault round-trip/tamper, l1 transfer equality and admission, static security scans, manifest validity.
//   node tools/pwa-wallet/test-core.mjs [--require-l1]
import assert from 'node:assert/strict';
import { createECDH, createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { vaultSecretLeaks } from './vault-leaks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const app = join(repo, 'website', 'app');
const requireL1 = process.argv.includes('--require-l1');
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

for (const file of ['vendor/noble-scure.js', 'vendor/qr.js', 'zyron-wallet-core.js']) {
  vm.runInThisContext(readFileSync(join(app, file), 'utf8'), { filename: file });
}
const core = globalThis.ZyronAppCore;
const V = globalThis.ZyronVendor;
const PASSWORD = 'correct horse battery staple';
const LINK_VECTOR_SIGNATURE = '5842cdffa0b26d57b399e5ca91432c747e6f335b18f556b0aad19d5826af2e81433265dcfec137121a884b777b4b2b2f43f60673e8a4127b259204a0e7dc5bcb';

// Public BIP-39 test phrases. Expected values are copied from the MetaMask Snap's vectors
// (PR #922, snap/test/vectors.json @ 9fc138583ebe9f1a7cc3e57e17e2eeee13f7ed94, derived with @metamask/key-tree).
// NEVER fund these addresses.
const SNAP_VECTORS = [
  { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    publicKey: '06317f0953a96539ad5435839ec3cfbdc8101dab70a9517a887466e882ca69ee5e4b3b52bbdee9fd4aec865685940bb31568887ba73ceaac153aebf77ad62d4c',
    address: 'ZYN16623f437e90cb7216ce70746f642717cc8b531f' },
  { mnemonic: 'test test test test test test test test test test test junk',
    publicKey: 'c1c03507f87433e86902f9673cb296b3f00079f035489b8d8460b36e3b84de92b2ed8541368f1490164365e126b7b518c6cfb29c27b990bf12ecfa472d4a7d66',
    address: 'ZYN0ac2dbccbd2a299dea4fcc2ddf98d7dd77eebb41' }
];

// ---------- independent reference: BIP-39 seed + BIP-32 derivation with node:crypto only ----------
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
function refSeed(mnemonic) { return pbkdf2Sync(Buffer.from(mnemonic.normalize('NFKD'), 'utf8'), Buffer.from('mnemonic', 'utf8'), 2048, 64, 'sha512'); }
function compressed(priv) { const e = createECDH('secp256k1'); e.setPrivateKey(priv); return e.getPublicKey(null, 'compressed'); }
function refDerive(seed, path) {
  let I = createHmac('sha512', 'Bitcoin seed').update(seed).digest();
  let key = I.subarray(0, 32); let chain = I.subarray(32);
  for (const part of path.split('/').slice(1)) {
    const hardened = part.endsWith("'");
    const index = (Number(hardened ? part.slice(0, -1) : part) + (hardened ? 0x80000000 : 0)) >>> 0;
    const ser = Buffer.alloc(4); ser.writeUInt32BE(index);
    const data = hardened ? Buffer.concat([Buffer.alloc(1), key, ser]) : Buffer.concat([compressed(key), ser]);
    I = createHmac('sha512', chain).update(data).digest();
    const child = (BigInt('0x' + I.subarray(0, 32).toString('hex')) + BigInt('0x' + key.toString('hex'))) % N;
    key = Buffer.from(child.toString(16).padStart(64, '0'), 'hex'); chain = I.subarray(32);
  }
  return key;
}
function refAccount(mnemonic) {
  const priv = refDerive(refSeed(mnemonic), "m/44'/249249'/0'/0/0");
  const e = createECDH('secp256k1'); e.setPrivateKey(priv);
  const publicKey = e.getPublicKey('hex', 'uncompressed').slice(2);
  return { privateKey: priv.toString('hex'), publicKey, address: 'ZYN' + createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 40) };
}
function refMnemonic(entropy) { // BIP-39 algorithm, independent of @scure/bip39 (word list is the standard data)
  const bits = [...entropy].map((b) => b.toString(2).padStart(8, '0')).join('') +
    createHash('sha256').update(entropy).digest()[0].toString(2).padStart(8, '0').slice(0, entropy.length / 4);
  return bits.match(/.{11}/g).map((chunk) => V.bip39.wordlist[parseInt(chunk, 2)]).join(' ');
}

await test('BIP-39 official vector (TREZOR passphrase) and word list sanity', async () => {
  assert.equal(V.bip39.wordlist.length, 2048);
  // SHA-256 of bitcoin/bips bip-0039/english.txt
  assert.equal(createHash('sha256').update(V.bip39.wordlist.join('\n') + '\n').digest('hex'), '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
  const seed = await V.bip39.mnemonicToSeed(SNAP_VECTORS[0].mnemonic, 'TREZOR');
  assert.equal(V.bytesToHex(seed), 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04');
  assert.equal(V.bytesToHex(seed), pbkdf2Sync(SNAP_VECTORS[0].mnemonic, 'mnemonicTREZOR', 2048, 64, 'sha512').toString('hex'));
});

await test("phrase -> m/44'/249249'/0'/0/0 -> address equals the MetaMask Snap vectors and an independent BIP-32 reference", async () => {
  assert.equal(core.DERIVATION_PATH, "m/44'/249249'/0'/0/0");
  const snapFile = join(repo, 'snap', 'test', 'vectors.json');
  if (existsSync(snapFile)) { // once PR #922 is merged, also bind to the Snap's own file
    const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
    assert.equal(snap.derivationPath, core.DERIVATION_PATH);
    assert.deepEqual(snap.vectors.map(({ mnemonic, publicKey, address }) => ({ mnemonic, publicKey, address })), SNAP_VECTORS);
  }
  for (const vector of SNAP_VECTORS) {
    const account = await core.deriveAccount(core.phraseToEntropy(vector.mnemonic));
    assert.equal(account.publicKey, vector.publicKey);
    assert.equal(account.address, vector.address);
    const ref = refAccount(vector.mnemonic);
    assert.equal(V.bytesToHex(account.privateKey), ref.privateKey);
    assert.equal(ref.address, vector.address);
  }
  for (let i = 0; i < 12; i += 1) {
    const entropy = new Uint8Array(randomBytes(i % 3 === 0 ? 32 : 16));
    const phrase = core.entropyToPhrase(entropy);
    assert.equal(phrase, refMnemonic(entropy));
    const account = await core.deriveAccount(core.phraseToEntropy(phrase.toUpperCase().split(' ').join('   ')));
    const ref = refAccount(phrase);
    assert.deepEqual({ publicKey: account.publicKey, address: account.address }, { publicKey: ref.publicKey, address: ref.address });
  }
});

await test('vault leak check: schema words are not leaks, secrets in values still are', async () => {
  // Some BIP-39 words occur inside the fixed vault schema (keys and pinned constants). A random 12-word phrase
  // contains one of them about 3% of the time, which made the browser test's leak check fail spuriously.
  const words = V.bip39.wordlist;
  const entropy = core.phraseToEntropy(SNAP_VECTORS[0].mnemonic);
  const account = await core.deriveAccount(entropy);
  const vault = await core.createVault(entropy, PASSWORD, account);
  const schemaWords = ['address', 'dress', 'public', 'vault', 'version'];
  for (const w of schemaWords) assert.ok(words.includes(w), `${w} is a BIP-39 word`);
  assert.deepEqual(vaultSecretLeaks(vault, schemaWords), [], 'fixed schema text is not a leak');
  const hex = V.bytesToHex(entropy);
  assert.deepEqual(vaultSecretLeaks(vault, [hex, PASSWORD, 'abandon']), []);
  assert.deepEqual(vaultSecretLeaks({ ...vault, ciphertext: vault.ciphertext + hex }, [hex]), [hex], 'secret inside a value is a leak');
  assert.deepEqual(vaultSecretLeaks({ ...vault, note: 'public dress' }, ['public', 'dress']), ['public', 'dress'], 'schema words inside an extra value are leaks');
  assert.deepEqual(vaultSecretLeaks({ ...vault, public: 1 }, ['public']), ['public'], 'an unknown key equal to a word is a leak');
  assert.deepEqual(vaultSecretLeaks({ ...vault, createdAt: 'version' }, ['version']), ['version'], 'a schema token used as a variable value is a leak');
});

await test('recovery phrase validation rejects bad input', () => {
  assert.throws(() => core.phraseToEntropy('abandon abandon abandon'), /12/);
  assert.throws(() => core.phraseToEntropy(SNAP_VECTORS[0].mnemonic.replace('about', 'abandon')), /checksum/);
  assert.throws(() => core.phraseToEntropy(SNAP_VECTORS[0].mnemonic.replace('about', 'aboutt')), /word list/);
  assert.equal(core.generateEntropy().length, 16);
  assert.equal(core.entropyToPhrase(core.generateEntropy()).split(' ').length, 12);
});

await test('vault: round-trip, fresh salt/IV, no plaintext, wrong password and every tamper fail', async () => {
  const entropy = core.phraseToEntropy(SNAP_VECTORS[0].mnemonic);
  const account = await core.deriveAccount(entropy);
  await assert.rejects(core.createVault(entropy, 'short', account), /12 characters/);
  const vault = await core.createVault(entropy, PASSWORD, account);
  const again = await core.createVault(entropy, PASSWORD, account);
  assert.notEqual(vault.salt, again.salt); assert.notEqual(vault.cipher.iv, again.cipher.iv); assert.notEqual(vault.ciphertext, again.ciphertext);
  assert.deepEqual(vault.kdf, { name: 'scrypt', n: 131072, r: 8, p: 1, dkLen: 32 });
  const text = JSON.stringify(vault);
  for (const secret of [V.bytesToHex(entropy), V.bytesToHex(account.privateKey), 'abandon', PASSWORD]) assert.ok(!text.includes(secret), 'vault leaks ' + secret.slice(0, 8));
  const opened = await core.openVault(vault, PASSWORD);
  assert.deepEqual([...opened.entropy], [...entropy]);
  assert.equal(opened.account.address, SNAP_VECTORS[0].address);
  await assert.rejects(core.openVault(vault, PASSWORD + '!'), /authentication failed/);
  const other = await core.deriveAccount(core.phraseToEntropy(SNAP_VECTORS[1].mnemonic));
  const flip = (hex, at) => hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1);
  const tampers = [
    [{ ...vault, ciphertext: flip(vault.ciphertext, 3) }, /authentication failed/],
    [{ ...vault, ciphertext: flip(vault.ciphertext, vault.ciphertext.length - 1) }, /authentication failed/],
    [{ ...vault, salt: flip(vault.salt, 0) }, /authentication failed/],
    [{ ...vault, cipher: { ...vault.cipher, iv: flip(vault.cipher.iv, 5) } }, /authentication failed/],
    [{ ...vault, address: other.address, publicKey: other.publicKey }, /authentication failed/],
    [{ ...vault, address: other.address }, /identity/],
    [{ ...vault, kdf: { ...vault.kdf, n: 16384 } }, /KDF/],
    [{ ...vault, kdf: { ...vault.kdf, n: 2 ** 30 } }, /KDF/],
    [{ ...vault, version: 3 }, /version/],
    [{ ...vault, version: 1 }, /unexpected fields/],
    [{ ...vault, book: { ...vault.book, ciphertext: flip(vault.book.ciphertext, 3) } }, /authentication failed/],
    [{ ...vault, book: { ...vault.book, iv: flip(vault.book.iv, 2) } }, /authentication failed/],
    [{ ...vault, derivationPath: "m/44'/60'/0'/0/0" }, /path/],
    [{ ...vault, words: 24 }, /ciphertext/],
    [{ ...vault, extra: 1 }, /unexpected/],
    [{ ...vault, ciphertext: vault.ciphertext.slice(0, -2) }, /ciphertext/]
  ];
  for (const [bad, pattern] of tampers) await assert.rejects(core.openVault(bad, PASSWORD), pattern);
  core.wipe(entropy, account.privateKey, opened.entropy, opened.account.privateKey, other.privateKey);
  assert.ok(account.privateKey.every((b) => b === 0), 'wipe zeroes buffers');
});

// Display checksum + password rule must match the website's CLI-first wallet core and docs.
const walletCoreContext = { TextEncoder, crypto: globalThis.crypto };
walletCoreContext.globalThis = walletCoreContext;
vm.createContext(walletCoreContext);
vm.runInContext(readFileSync(join(repo, 'website', 'wallet-core.js'), 'utf8'), walletCoreContext);
const siteCore = walletCoreContext.ZyronWalletCore;

await test('vault parser fails closed: unknown versions, malformed data, prototypes and extra fields are rejected', async () => {
  const entropy = core.phraseToEntropy(SNAP_VECTORS[1].mnemonic);
  const account = await core.deriveAccount(entropy);
  const vault = await core.createVault(entropy, PASSWORD, account);
  const parsed = core.parseVault(vault);
  assert.deepEqual(parsed, vault);
  assert.notEqual(parsed, vault, 'parseVault returns a fresh copy');
  assert.deepEqual(core.parseVault(JSON.stringify(vault)), vault, 'JSON text is accepted when it is exactly a v2 vault');
  const bad = [
    [null, /plain object/], [undefined, /plain object/], [42, /plain object/], ['not json', /valid JSON/], ['[]', /plain object/],
    ['x'.repeat(core.MAX_VAULT_TEXT + 1), /too large/], [[vault], /plain object/],
    [Object.assign(Object.create({ evil: true }), vault), /plain object/],
    [{ ...vault, version: 0 }, /version/], [{ ...vault, version: 3 }, /version/], [{ ...vault, version: '1' }, /version/], [{ ...vault, version: '2' }, /version/], [{ ...vault, version: 1.5 }, /version/],
    [{ ...vault, format: 'zyronchain-pwa-vault-v2' }, /format/],
    [{ ...vault, createdAt: 'yesterday' }, /creation time/], [{ ...vault, createdAt: 12 }, /creation time/],
    [{ ...vault, words: '12' }, /word count/],
    [{ ...vault, kdf: [] }, /KDF/], [{ ...vault, kdf: { ...vault.kdf, extra: 1 } }, /KDF/],
    [{ ...vault, cipher: { ...vault.cipher, name: 'aes-128-gcm' } }, /cipher/], [{ ...vault, cipher: 'aes' }, /cipher/],
    [{ ...vault, salt: 'zz' }, /salt/], [{ ...vault, ciphertext: 'ABC' }, /ciphertext/],
    [(({ createdAt, ...rest }) => rest)(vault), /unexpected fields/], [(({ book, ...rest }) => rest)(vault), /unexpected fields/],
    [{ ...vault, book: 'x' }, /address book/], [{ ...vault, book: { ...vault.book, extra: 1 } }, /address book/], [{ ...vault, book: { ...vault.book, iv: vault.cipher.iv } }, /address book/], [{ ...vault, __proto__: null, extra: 1 }, /unexpected fields/]
  ];
  for (const [value, pattern] of bad) {
    assert.throws(() => core.parseVault(value), pattern, `parseVault(${String(JSON.stringify(value)).slice(0, 40)})`);
    if (value && typeof value === 'object') await assert.rejects(core.openVault(value, PASSWORD), pattern);
  }
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
  assert.match(appJs, /state\.vault = core\.parseVault\(stored\); \/\/ unknown or malformed vaults are rejected, never rewritten/);
  assert.doesNotMatch(appJs, /migrat/i, 'no silent vault migration');
  core.wipe(entropy, account.privateKey);
});

await test('vault migration: a version-1 fixture still opens and upgrades to version 2 with the same identity', async () => {
  // Fixture written by the version-1 code (main before this change) for the public "test ... junk" phrase. NEVER fund it.
  const v1 = JSON.parse(readFileSync(join(here, 'fixtures', 'vault-v1.json'), 'utf8'));
  assert.equal(v1.version, 1);
  assert.equal(core.VAULT_VERSION, 2);
  assert.deepEqual(core.parseVault(v1), v1, 'version-1 vaults stay readable');
  assert.deepEqual(core.parseVault(JSON.stringify(v1)), v1);
  const opened = await core.openVault(v1, PASSWORD);
  assert.equal(opened.account.address, SNAP_VECTORS[1].address);
  assert.deepEqual(opened.book, core.emptyBook(), 'a version-1 vault opens with an empty address book');
  await assert.rejects(core.openVault(v1, PASSWORD + '!'), /authentication failed/);
  await assert.rejects(core.upgradeVault(v1, null), /Unlock/);
  const before = JSON.stringify(v1);
  const v2 = await core.upgradeVault(v1, opened);
  assert.equal(JSON.stringify(v1), before, 'the input vault is not modified');
  assert.equal(v2.version, 2);
  for (const k of ['format', 'createdAt', 'address', 'publicKey', 'derivationPath', 'words', 'salt']) assert.deepEqual(v2[k], v1[k], k + ' is kept');
  assert.notEqual(v2.cipher.iv, v1.cipher.iv, 'seed is re-sealed with a fresh IV');
  assert.deepEqual(core.parseVault(v2), v2);
  assert.deepEqual(vaultSecretLeaks(v2, [V.bytesToHex(opened.entropy), PASSWORD, 'test', 'junk']), []);
  const again = await core.openVault(v2, PASSWORD);
  assert.deepEqual([...again.entropy], [...opened.entropy]);
  assert.deepEqual(again.book, core.emptyBook());
  // Downgrade / mix-and-match: a v2 seed ciphertext under a v1 label fails authentication.
  const { book: _b, ...noBook } = v2;
  await assert.rejects(core.openVault({ ...noBook, version: 1 }, PASSWORD), /authentication failed/);
  await assert.rejects(core.openVault({ ...v1, version: 2, book: v2.book }, PASSWORD), /authentication failed/);
  const same = await core.upgradeVault(v2, again);
  assert.deepEqual(same, v2, 'upgrading a version-2 vault is a no-op copy');
  core.wipe(opened.entropy, opened.account.privateKey, again.entropy, again.account.privateKey);
});

await test('vault upgrade is verified before it may be stored; rollback marker refuses a v1 vault after v2', async () => {
  const v1 = JSON.parse(readFileSync(join(here, 'fixtures', 'vault-v1.json'), 'utf8'));
  const opened = await core.openVault(v1, PASSWORD);
  const { vault: v2, opened: check } = await core.upgradeVaultVerified(v1, opened, PASSWORD);
  assert.equal(v2.version, 2);
  assert.equal(check.account.address, v1.address, 'the upgraded vault reopened to the same address');
  await assert.rejects(core.upgradeVaultVerified(v1, opened, PASSWORD + '!'), /authentication failed/, 'a different password cannot pass the check');
  // A broken upgrade (wrong seed sealed) is caught by the reopen check before anything could be stored.
  const other = await core.deriveAccount(core.phraseToEntropy(SNAP_VECTORS[0].mnemonic));
  const forged = { ...opened, entropy: core.phraseToEntropy(SNAP_VECTORS[0].mnemonic) };
  await assert.rejects(core.upgradeVaultVerified(v1, forged, PASSWORD), /different identity|upgrade check failed/);
  // Rollback marker
  const marker = core.upgradeMarker(v1.address);
  assert.deepEqual(core.parseUpgradeMarker(JSON.parse(JSON.stringify(marker))), marker);
  assert.equal(core.isRollback(v1, marker), true, 'v1 for an address already seen at v2 is refused');
  assert.equal(core.isRollback(v2, marker), false);
  assert.equal(core.isRollback(v1, null), false, 'no marker: v1 still opens and upgrades');
  assert.equal(core.isRollback(v1, core.upgradeMarker(other.address)), false, 'marker for another wallet does not block');
  for (const bad of [{}, { ...marker, version: 1 }, { ...marker, extra: 1 }, { ...marker, address: 'x' }, { ...marker, format: 'nope' }]) {
    assert.throws(() => core.parseUpgradeMarker(bad), /marker is invalid/);
    assert.throws(() => core.isRollback(v1, bad), /marker is invalid/, 'a malformed marker fails closed');
  }
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
  const unlock = appJs.slice(appJs.indexOf('async function unlock()'), appJs.indexOf("$('[data-unlock-go]')"));
  assert.ok(unlock.indexOf('upgradeVaultVerified(') > 0 && unlock.indexOf('upgradeVaultVerified(') < unlock.indexOf('saveVault('), 'reopen check runs before saveVault');
  assert.ok(unlock.indexOf('V1_BACKUP_KEY, v1)') < unlock.indexOf('saveVault('), 'the v1 copy is stored before v1 is replaced');
  assert.match(unlock, /deleteMeta\(V1_BACKUP_KEY\)/, 'the v1 copy is removed after a later v2 unlock');
  assert.match(appJs, /window\.addEventListener\('pagehide', \(\) => \{[^\n]*lock\(t\('msgLocked'\)\); \}\);/, 'pagehide locks (drops key and book)');
  core.wipe(opened.entropy, opened.account.privateKey, check.entropy, check.account.privateKey, other.privateKey, forged.entropy);
});

await test('vault address book: round-trip through the encrypted vault, tamper fails, nothing in plaintext', async () => {
  const entropy = core.phraseToEntropy(SNAP_VECTORS[0].mnemonic);
  const account = await core.deriveAccount(entropy);
  const vault = await core.createVault(entropy, PASSWORD, account);
  assert.equal(vault.version, 2);
  const opened = await core.openVault(vault, PASSWORD);
  assert.deepEqual(opened.book, core.emptyBook());
  const friend = SNAP_VECTORS[1].address;
  const third = 'ZYN' + '12'.repeat(20);
  let book = core.addContact(opened.book, { name: '  Test   Friend ', address: core.toChecksumAddress(friend) });
  assert.deepEqual(book.contacts, [{ name: 'Test Friend', address: friend }]);
  assert.deepEqual(opened.book.contacts, [], 'book helpers return copies');
  assert.throws(() => core.addContact(book, { name: 'Dup', address: friend }), /already/);
  assert.throws(() => core.addContact(book, { name: '', address: third }), /name is required/);
  assert.throws(() => core.addContact(book, { name: 'x'.repeat(65), address: third }), /too long/);
  assert.throws(() => core.addContact(book, { name: 'Bad', address: 'ZYN123' }), /40 hex/);
  assert.throws(() => core.addContact(book, { name: 'Sys', address: core.MINING_TRACKER_ADDRESS }), /reserved/);
  book = core.addContact(book, { name: 'Third', address: third });
  book = core.updateContact(book, third, { name: 'Third renamed', address: third });
  assert.equal(core.findContact(book, third).name, 'Third renamed');
  assert.throws(() => core.updateContact(book, third, { name: 'Clash', address: friend }), /already/);
  assert.throws(() => core.updateContact(book, 'ZYN' + 'ab'.repeat(20), { name: 'X', address: third }), /not found/);
  book = core.recordSent(book, friend);
  book = core.setThreshold(book, 5 * core.ATOMS_PER_ZYN);
  assert.throws(() => core.setThreshold(book, 0), /at least 1 atom/);
  const updated = await core.updateVaultBook(vault, opened.key, book);
  assert.notEqual(updated.book.iv, vault.book.iv, 'fresh IV on every save');
  assert.equal(updated.ciphertext, vault.ciphertext, 'the seed ciphertext is untouched by a book save');
  const text = JSON.stringify(updated);
  for (const secret of ['Test Friend', 'Third renamed', friend.slice(3), third.slice(3)]) assert.ok(!text.includes(secret), 'book leaks ' + secret);
  const reopened = await core.openVault(core.parseVault(JSON.stringify(updated)), PASSWORD);
  assert.deepEqual(reopened.book, book, 'round-trip');
  const flip = (hex, at) => hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1);
  await assert.rejects(core.openVault({ ...updated, book: { ...updated.book, ciphertext: flip(updated.book.ciphertext, 1) } }, PASSWORD), /authentication failed/);
  await assert.rejects(core.openVault({ ...updated, book: vault.book, cipher: { ...updated.cipher, iv: flip(updated.cipher.iv, 0) } }, PASSWORD), /authentication failed/);
  const removed = core.removeContact(book, third);
  assert.deepEqual(removed.contacts.map((c) => c.address), [friend]);
  assert.throws(() => core.removeContact(removed, third), /not found/);
  for (const bad of [null, {}, { ...book, extra: 1 }, { ...book, contacts: [{ name: 'a', address: 'nope' }] }, { ...book, thresholdAtoms: -1 }, { ...book, sent: [friend, friend] }]) {
    assert.throws(() => core.parseBook(bad), /invalid/i);
  }
  core.wipe(entropy, account.privateKey, opened.entropy, opened.account.privateKey, reopened.entropy, reopened.account.privateKey);
});

await test('lookalike detection: crafted prefix/suffix collisions, exact matches, case/checksum variants, cap', async () => {
  const account = await core.deriveAccount(core.phraseToEntropy(SNAP_VECTORS[0].mnemonic));
  const one = core.ATOMS_PER_ZYN;
  assert.equal(core.LOOKALIKE_MIN_SHARED, 6);
  assert.equal(core.LOOKALIKE_PREFIX, undefined, 'the fixed 4+4 rule is replaced');
  const known = 'ZYN' + 'abcd' + '0123456789'.repeat(3) + '01' + 'ef01';
  assert.match(known, /^ZYN[0-9a-f]{40}$/);
  // same first 4 and last 4 hex characters, every middle character different
  const poison = 'ZYN' + 'abcd' + 'f'.repeat(32) + 'ef01';
  let book = core.addContact(core.emptyBook(), { name: 'Alice', address: known });
  let r = core.lookalikeMatches(poison, book);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].address, known);
  assert.equal(r.matches[0].source, 'contact');
  assert.equal(r.matches[0].name, 'Alice');
  assert.equal(r.matches[0].diff.length, 32, 'the full address is compared, not just the ends');
  assert.deepEqual(r.matches[0].diff, core.addressDiff(poison, known));
  const w = core.sendWarnings({ receiver: poison, amountAtoms: one }, account, book);
  assert.deepEqual(w.map((x) => x.code), ['lookalike', 'first-time']);
  assert.equal(w[0].blocking, false);
  assert.equal(w[0].receiver, poison);
  assert.match(w[0].message, /"Alice".*DIFFERENT/);
  // exact full match (any case / checksummed form) is never a lookalike
  for (const v of [known, known.toUpperCase().replace(/^ZYN/, 'ZYN'), core.toChecksumAddress(known), '  ' + core.toChecksumAddress(known) + ' ']) {
    if (v === known.toUpperCase().replace(/^ZYN/, 'ZYN')) { assert.throws(() => core.lookalikeMatches(v, book), /Checksum/); continue; }
    assert.deepEqual(core.lookalikeMatches(v, book).matches, [], 'exact match: ' + v);
    assert.ok(!core.sendWarnings({ receiver: v, amountAtoms: one }, account, book).some((x) => x.code === 'lookalike'));
  }
  // checksummed poison input still detected; a wrong checksum is rejected before any comparison
  assert.equal(core.lookalikeMatches(core.toChecksumAddress(poison), book).matches.length, 1);
  // prefix only or suffix only (with a large middle difference) is not flagged
  assert.deepEqual(core.lookalikeMatches('ZYN' + 'abcd' + 'f'.repeat(32) + '9999', book).matches, []);
  assert.deepEqual(core.lookalikeMatches('ZYN' + '9999' + 'f'.repeat(32) + 'ef01', book).matches, []);
  // 3 prefix + 4 suffix = 7 shared: flagged under the prefix+suffix >= 6 rule
  assert.equal(core.lookalikeMatches('ZYN' + 'abc0' + 'f'.repeat(32) + 'ef01', book).matches.length, 1);
  // small edit distance (1-2 hex positions) is flagged even if the ends differ
  const oneOff = 'ZYN' + '0bcd' + known.slice(7);
  assert.deepEqual(core.lookalikeMatches(oneOff, book).matches[0].diff, [0]);
  const flip = (addr, idx) => 'ZYN' + [...addr.slice(3)].map((c, i) => (idx.includes(i) ? (c === 'f' ? '0' : 'f') : c)).join('');
  const threeOff = flip(known, [0, 20, 39]);
  assert.equal(core.addressDiff(threeOff, known).length, 3);
  assert.deepEqual(core.lookalikeMatches(threeOff, book).matches, [], 'three differences with no shared ends are not flagged');
  // prefix + suffix >= LOOKALIKE_MIN_SHARED for any split; build a candidate sharing exactly p prefix and s suffix chars
  const shared = (p, sfx) => flip(known, [...Array(40).keys()].filter((i) => i >= p && i < 40 - sfx));
  for (const [p, sfx] of [[3, 3], [5, 3], [6, 0], [0, 6], [4, 4], [1, 5]]) {
    const cand = shared(p, sfx);
    const m = core.lookalikeMatches(cand, book).matches;
    assert.equal(m.length, 1, p + '+' + sfx + ' is flagged');
    assert.deepEqual([m[0].prefix, m[0].suffix], [p, sfx]);
  }
  for (const [p, sfx] of [[3, 2], [5, 0], [0, 5], [2, 3], [0, 0]]) {
    assert.deepEqual(core.lookalikeMatches(shared(p, sfx), book).matches, [], p + '+' + sfx + ' (under 6) is not flagged');
  }
  // overlap: one difference in the middle gives prefix + suffix = 39, never more than 40 minus the differences
  const mid = core.lookalikeMatches(flip(known, [17]), book).matches[0];
  assert.equal(mid.prefix + mid.suffix, 39);
  // random non-match control (deterministic PRNG): unrelated addresses are not flagged
  let seed = 0x2545f491;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % 16; };
  let flagged = 0;
  for (let n = 0; n < 2000; n += 1) {
    const a = 'ZYN' + Array.from({ length: 40 }, () => rnd().toString(16)).join('');
    if (core.lookalikeMatches(a, book).matches.length) flagged += 1;
  }
  assert.equal(flagged, 0, 'random addresses are not flagged against an unrelated contact');
  // sent history is compared too
  book = core.recordSent(core.emptyBook(), core.toChecksumAddress(known));
  r = core.lookalikeMatches(poison, book);
  assert.equal(r.matches[0].source, 'history');
  assert.equal(r.matches[0].name, null);
  assert.match(core.sendWarnings({ receiver: poison, amountAtoms: one }, account, book)[0].message, /sent to before/);
  // the receiver itself in history plus a lookalike contact: the contact is still flagged, the exact entry is not
  book = core.addContact(core.recordSent(core.emptyBook(), poison), { name: 'Alice', address: known });
  assert.deepEqual(core.lookalikeMatches(poison, book).matches.map((m) => m.address), [known]);
  // cap: at most LOOKALIKE_MAX_COMPARISONS known addresses are compared (contacts first, then newest history)
  const hex = (i, p) => 'ZYN' + p + i.toString(16).padStart(36, '0');
  let big = core.emptyBook();
  for (let i = 0; i < core.BOOK_MAX_CONTACTS; i += 1) big = core.addContact(big, { name: 'C' + i, address: hex(i, '1111') });
  const oldest = 'ZYN' + '7777' + '5'.repeat(32) + '7777';
  big = core.recordSent(big, oldest);
  for (let i = 0; i < core.BOOK_MAX_SENT - 1; i += 1) big = core.recordSent(big, hex(i, '2222'));
  assert.equal(big.sent.length, core.BOOK_MAX_SENT);
  assert.equal(big.sent[big.sent.length - 1], oldest);
  const probe = 'ZYN' + '7777' + 'a'.repeat(32) + '7777';
  r = core.lookalikeMatches(probe, big);
  assert.ok(core.LOOKALIKE_MAX_COMPARISONS < core.BOOK_MAX_CONTACTS + core.BOOK_MAX_SENT);
  assert.equal(r.compared, core.LOOKALIKE_MAX_COMPARISONS);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.matches, [], 'an entry beyond the cap is not compared');
  const fresh = core.recordSent(big, oldest); // moves to most recent
  assert.deepEqual(core.lookalikeMatches(probe, fresh).matches.map((m) => m.address), [oldest]);
  // number of reported matches is bounded
  let many = core.emptyBook();
  for (let i = 0; i < 6; i += 1) many = core.addContact(many, { name: 'M' + i, address: 'ZYN' + 'abcd' + String(i).repeat(32) + 'ef01' });
  assert.equal(core.lookalikeMatches(poison, many).matches.length, core.LOOKALIKE_MAX_MATCHES);
  // grouped display
  assert.equal(core.displayAddress(known), core.groupAddress(core.toChecksumAddress(known)));
  assert.match(core.displayAddress(known), /^ZYN( [0-9a-fA-F]{4}){10}$/);
  // app wiring: separate acknowledgement, DOM-built highlight, no innerHTML, history is display-only
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
  const html = readFileSync(join(app, 'index.html'), 'utf8');
  assert.match(html, /data-review-lookalike-ack/);
  assert.match(appJs, /function warningsAccepted\(\) \{ return lookalikeAccepted\(\) && /);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(appJs), 'no HTML injection APIs in app.js');
  assert.ok(!/<datalist/.test(html), 'no receiver suggestions');
  assert.match(html, /<input data-tx-to autocomplete="off"/);
  assert.ok(!/history[^\n]*data-tx-to|data-tx-to[^\n]*sent\[/.test(appJs), 'history never fills the receiver');
  core.wipe(account.privateKey);
});

await test('send-safety warnings: first-time recipient, own address, amount at or above the threshold', async () => {
  const account = await core.deriveAccount(core.phraseToEntropy(SNAP_VECTORS[0].mnemonic));
  const friend = SNAP_VECTORS[1].address;
  const one = core.ATOMS_PER_ZYN;
  const codes = (list) => list.map((w) => w.code);
  let book = core.emptyBook();
  assert.deepEqual(codes(core.sendWarnings({ receiver: friend, amountAtoms: one }, account, book)), ['first-time']);
  const self = core.sendWarnings({ receiver: core.toChecksumAddress(account.address), amountAtoms: one }, account, book);
  assert.deepEqual(self.map((w) => [w.code, w.blocking]), [['self', true]]);
  assert.equal(self[0].message, "You can't send to your own address. Enter a different recipient.");
  assert.throws(() => core.buildTransfer({ version: 1, chainId: core.WALLET_TESTNET_CHAIN_ID, nonce: 1, receiver: account.address, amountAtoms: one, feeAtoms: 100000 }, account),
    (error) => error.message === core.SELF_SEND_MESSAGE, 'builder uses the same plain wording');
  book = core.addContact(book, { name: 'Friend', address: friend });
  const saved = core.sendWarnings({ receiver: friend, amountAtoms: one }, account, book);
  assert.deepEqual(codes(saved), ['first-time'], 'a saved contact that was never paid still warns');
  assert.match(saved[0].message, /"Friend"/);
  book = core.recordSent(book, core.toChecksumAddress(friend));
  assert.deepEqual(codes(core.sendWarnings({ receiver: friend, amountAtoms: one }, account, book)), [], 'known recipient, no threshold: no warning');
  book = core.setThreshold(book, 10 * one);
  assert.deepEqual(codes(core.sendWarnings({ receiver: friend, amountAtoms: 10 * one - 1 }, account, book)), [], 'just below threshold');
  assert.deepEqual(codes(core.sendWarnings({ receiver: friend, amountAtoms: 10 * one }, account, book)), ['large-amount'], 'exactly at threshold');
  assert.deepEqual(codes(core.sendWarnings({ receiver: 'ZYN' + '34'.repeat(20), amountAtoms: 20 * one }, account, book)), ['first-time', 'large-amount']);
  assert.match(core.sendWarnings({ receiver: friend, amountAtoms: 12 * one }, account, book)[0].message, /12 ZYN.*10 ZYN/);
  assert.throws(() => core.sendWarnings({ receiver: 'bad', amountAtoms: one }, account, book), /40 hex/);
  // sent history is bounded and most-recent-first
  let big = core.emptyBook();
  for (let i = 0; i < core.BOOK_MAX_SENT + 5; i += 1) big = core.recordSent(big, 'ZYN' + i.toString(16).padStart(40, '0').replace(/^0/, '1'));
  assert.equal(big.sent.length, core.BOOK_MAX_SENT);
  // app wiring: warnings are checked before building, need their own checkbox, and the sign handler re-checks it
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
  const html = readFileSync(join(app, 'index.html'), 'utf8');
  assert.match(appJs, /const blocking = warnings\.find\(\(w\) => w\.blocking\);\n\s+if \(blocking\) throw new Error\(blocking\.message\);/);
  assert.match(appJs, /\.checked\) return;\n\s+if \(!warningsAccepted\(\)\) return; \/\/ send-safety warnings need their own confirmation/);
  assert.match(html, /data-review-warn-ack/);
  assert.match(appJs, /state\.vaultKey = null;/, 'the vault key is dropped on lock');
  core.wipe(account.privateKey);
});

await test('crypto self-test passes with the vendored libraries and refuses to run without them', async () => {
  assert.equal(await core.selfTest(), true);
  const saved = globalThis.ZyronVendor;
  try {
    globalThis.ZyronVendor = undefined;
    await assert.rejects(core.selfTest(), /not loaded/);
    globalThis.ZyronVendor = { ...saved, scryptAsync: undefined };
    await assert.rejects(core.selfTest(), /incomplete: scryptAsync/);
    globalThis.ZyronVendor = { ...saved, sha256: () => new Uint8Array(32) };
    await assert.rejects(core.selfTest(), /SHA-256 self-test failed/);
  } finally {
    globalThis.ZyronVendor = saved;
  }
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
  assert.match(appJs, /await core\.selfTest\(\);/);
  assert.match(appJs, /msgCryptoMissing/);
});

await test('signing review: shows every field, refuses unknown types, messages and extra fields', async () => {
  const entropy = core.phraseToEntropy(SNAP_VECTORS[0].mnemonic);
  const account = await core.deriveAccount(entropy);
  const unsigned = core.buildTransfer({ version: 2, chainId: 'zyron-review-testnet', nonce: 7, receiver: 'ZYN5D99EE966b42cD8fC7bdD1364B389153A9E78B42', amountAtoms: 150000000, feeAtoms: 1000, timestampMs: 1700000000000 }, account);
  const rows = core.describeTransfer(unsigned);
  assert.deepEqual(rows.map((r) => r.key), ['type', 'from', 'to', 'amount', 'fee', 'total', 'chain', 'nonce', 'time']);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  assert.match(byKey.type, /^Transfer \(kind "transfer", version 2\)$/);
  assert.equal(byKey.from, core.toChecksumAddress(account.address));
  assert.equal(byKey.to, 'ZYN5D99EE966b42cD8fC7bdD1364B389153A9E78B42');
  assert.equal(byKey.amount, '1.5 ZYN (150000000 atoms)');
  assert.equal(byKey.fee, '0.00001 ZYN (1000 atoms)');
  assert.equal(core.fixedFeeRejection(unsigned), undefined, 'a historical review chain may still use another fee');
  assert.throws(() => core.signTransfer({ ...unsigned, chainId: 'zyron-open-testnet-1' }, account.privateKey), /will reject this fee/);
  const allowed = core.buildTransfer({ ...unsigned, chainId: 'zyron-open-testnet-1', feeAtoms: 100000 }, account);
  assert.equal(core.fixedFeeRejection(allowed), undefined);
  assert.equal(core.signTransfer(allowed, account.privateKey).feeAtoms, 100000);
  assert.equal(byKey.total, '1.50001 ZYN (150001000 atoms)');
  assert.equal(byKey.chain, 'zyron-review-testnet');
  assert.equal(byKey.nonce, '7');
  for (const [bad, pattern] of [
    [{ ...unsigned, kind: 'mining_claim' }, /transfers only/], [{ ...unsigned, kind: 'message' }, /transfers only/], [{ ...unsigned, kind: undefined }, /transfers only/],
    [{ ...unsigned, memo: 'x' }, /Unexpected transfer fields/], [{ ...unsigned, data: '0x' }, /Unexpected transfer fields/],
    [{ ...unsigned, version: 3 }, /version/], [{ ...unsigned, chainId: '' }, /Chain ID/], [{ ...unsigned, chainId: 'zyron-mainnet-1' }, /testnet or devnet/], [{ ...unsigned, nonce: 0 }, /Nonce/],
    [{ ...unsigned, receiver: core.MINING_TRACKER_ADDRESS }, /reserved system address/], [{ ...unsigned, sender: 'ZYN' + '1'.repeat(40) }, /Sender does not match/],
    [JSON.stringify(unsigned), /Nothing to review/], [['transfer'], /Nothing to review/]
  ]) {
    assert.throws(() => core.describeTransfer(bad), pattern);
    assert.throws(() => core.signTransfer(bad, account.privateKey), /transfers only|Unexpected|version|Chain ID|Nonce|reserved system address|Sender|Nothing/);
  }
  const html = readFileSync(join(app, 'index.html'), 'utf8');
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
  assert.match(html, /data-screen="review"/);
  assert.match(html, /data-tx-sign disabled/, 'sign button starts disabled until the review is confirmed');
  assert.match(appJs, /if \(!state\.unsigned \|\| !\$\('\[data-review-ack\]'\)\.checked\) return;/);
  core.wipe(entropy, account.privateKey);
});

await test('recovery phrase UX: privacy screen first, words hidden by default, no copy path, randomized multi-word check', () => {
  const html = readFileSync(join(app, 'index.html'), 'utf8');
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
  assert.ok(html.indexOf('data-screen="privacy"') < html.indexOf('data-screen="phrase"'), 'privacy screen precedes the phrase');
  for (const text of ['controls the wallet', 'support will never ask', 'Telegram, Discord, X, email', 'airdrop, validator', 'on paper', 'nobody can see your screen', 'cannot block screenshots']) assert.ok(html.toLowerCase().includes(text.toLowerCase()), text);
  assert.match(html, /data-privacy-next disabled/);
  assert.doesNotMatch(html + appJs, /data-copy-phrase|copy (the )?(recovery )?phrase|copyPhrase/i, 'no copy-phrase control');
  assert.doesNotMatch(html + appJs, /screenshots? (are|is) (blocked|disabled|prevented)/i, 'never claims screenshots are blocked');
  assert.match(appJs, /text\.textContent = '•••••';/, 'cards render a placeholder until revealed');
  assert.match(appJs, /const WORD_HIDE_MS = 20 \* 1000;/);
  assert.match(appJs, /window\.addEventListener\('blur', hideWords\);/);
  assert.match(appJs, /if \(document\.hidden\) \{\n\s+hideWords\(\);/);
  assert.match(appJs, /const QUIZ_WORDS = 4;/);
  assert.match(appJs, /for \(const type of \['copy', 'cut', 'dragstart'\]\)/);
  assert.doesNotMatch(appJs, /pending\.words|words: core\.entropyToPhrase/, 'the phrase is not kept as a long-lived string list');
  assert.match(appJs, /core\.wipe\(state\.pending\.entropy\);/);
  assert.match(html, /data-screen="send"/);
  assert.match(html, /data-screen="backup"/);
  assert.match(html, /data-backup-reminder/);
  assert.match(appJs, /state\.backupConfirmed = false;/);
  assert.match(appJs, /if \(state\.backupEntropy\) core\.wipe\(state\.backupEntropy\);/);
  assert.doesNotMatch(appJs, /backupConfirmed[\s\S]{0,120}(localStorage|sessionStorage|indexedDB)/);
  assert.match(html, /JavaScript cannot guarantee that memory is erased/);
  // copy is only offered for the address and a signed transfer
  const copyButtons = [...html.matchAll(/<button\b[^>]*>[^<]*<\/button>/g)].map((m) => m[0]).filter((b) => /copy/i.test(b)).map((b) => b.match(/data-([a-z-]+)/)[1]).sort();
  assert.deepEqual(copyButtons, ['copy-address', 'copy-plain', 'link-copy', 'signed-copy', 'tx-copy']); // signed-copy: the held signed transfer on Receive
  assert.ok(appJs.includes("msgCopied: 'Copied. This app will try to clear the clipboard in 60 seconds.'"));
  assert.ok(appJs.includes('msgClipboardKept'));
});

await test('network status component: static, honest rows, identical everywhere it is used', async () => {
  const { ROWS, render, OPEN_TESTNET_GATEWAY } = await import(pathToFileURL(join(repo, 'tools', 'site', 'network-status.mjs')).href);
  const expected = { governance: 'Authorized', 'public-testnet': 'Open no-value profile', 'public-rpc': 'Open testnet gateway', explorer: 'Open testnet page', 'wallet-creation': 'Available locally', 'offline-signing': 'Available', broadcasting: 'Testnet transfers only', mining: 'Retired', 'token-sale': 'None' };
  assert.deepEqual(Object.fromEntries(ROWS.map((r) => [r.key, r.value])), expected);
  const block = render();
  assert.ok(block.includes(OPEN_TESTNET_GATEWAY));
  assert.ok(block.includes('data-ns-live'));
  for (const page of ['website/app/index.html', 'website/index.html', 'website/wallet.html']) {
    const file = join(repo, page);
    if (!existsSync(file)) continue;
    const html = readFileSync(file, 'utf8');
    if (!html.includes('BEGIN NETWORK STATUS')) { assert.notEqual(page, 'website/app/index.html', 'the phone wallet shows network status'); continue; }
    const expected = page.endsWith('website/app/index.html') ? render({ variant: 'wallet' }) : block;
    const got = html.match(/<!-- BEGIN NETWORK STATUS[\s\S]*?<!-- END NETWORK STATUS -->/)[0].split('\n').map((l) => l.trim()).join('\n');
    assert.equal(got, expected.split('\n').map((l) => l.trim()).join('\n'), `${page} network status is stale`);
  }
  const walletBlock = render({ variant: 'wallet' });
  assert.match(walletBlock, /does not poll any network/);
  assert.match(walletBlock, /does not connect, so it does not refresh/);
  assert.match(walletBlock, /This phone app does not submit transfers/);
  assert.doesNotMatch(walletBlock, /Enable JavaScript to refresh/);
  assert.doesNotMatch(block, /mainnet (is )?live|activated public testnet|public rpc: available|buy now|price target|\$\s?\d|live trading/i);
  assert.doesNotMatch(block, new RegExp(String.raw`https?:\/\/(?!github\.com|zyron-open-testnet\.onrender\.com)`), 'only documented open-testnet gateway or github');
});

await test('display checksum vectors (docs/ADDRESS_CHECKSUM.md) and password rule equal website/wallet-core.js', async () => {
  const spec = readFileSync(join(repo, 'docs', 'ADDRESS_CHECKSUM.md'), 'utf8');
  const rows = [...spec.matchAll(/\| `(ZYN[0-9a-f]{40})` \| `(ZYN[0-9a-fA-F]{40})` \|/g)];
  assert.ok(rows.length >= 7);
  for (const [, canonical, checksummed] of rows) {
    assert.equal(core.toChecksumAddress(canonical), checksummed);
    assert.equal(core.parseAddressInput(checksummed).canonical, canonical);
  }
  assert.throws(() => core.parseAddressInput(rows[0][2].replace(/[A-F]/, (c) => c.toLowerCase())), /Checksum mismatch/);
  for (let i = 0; i < 64; i += 1) {
    const address = 'ZYN' + randomBytes(20).toString('hex');
    assert.equal(core.toChecksumAddress(address), await siteCore.toChecksumAddress(address));
    const sample = randomBytes(1 + (i % 20)).toString(i % 2 ? 'base64' : 'latin1');
    assert.deepEqual({ ...core.passwordStrength(sample) }, { ...siteCore.passwordStrength(sample) });
  }
  for (const value of ['0', '1', '0.00000001', '12.5', '50000000']) assert.equal(String(core.zynToAtoms(value)), siteCore.zynToAtoms(value));
  assert.equal(core.atomsToZyn('150000000'), '1.5');
  assert.equal(core.FIXED_TRANSFER_FEE_ATOMS, 100000);
  assert.equal(core.atomsToZyn(String(core.FIXED_TRANSFER_FEE_ATOMS)), '0.001');
  assert.deepEqual(core.FIXED_SUPPLY_V1_CHAIN_IDS, ['zyron-open-testnet-1', 'zyron-open-testnet-render-1', 'zyron-public-testnet-1']);
  const reject = 'This network will reject this fee. The protocol fee is 100000 atoms (0.001 ZYN). Nothing was signed.';
  for (const chainId of core.FIXED_SUPPLY_V1_CHAIN_IDS) {
    assert.equal(core.fixedFeeRejection({ chainId, feeAtoms: 0 }), reject, chainId);
    assert.equal(core.fixedFeeRejection({ chainId, feeAtoms: 100000 }), undefined, chainId);
  }
  assert.equal(core.fixedFeeRejection({ chainId: 'zyron-wallet-testnet-1', feeAtoms: 0 }), undefined);
  assert.equal(core.fixedFeeRejection({ chainId: 'zyron-review-testnet', feeAtoms: 1000 }), undefined);
  assert.equal(core.fixedFeeRejection({ chainId: 'zyron-wallet-testnet-1', feeAtoms: 0, launchProfile: 'fixed-supply-v1' }), reject);
  assert.equal(core.fixedFeeRejection({ chainId: 'zyron-wallet-testnet-1', feeAtoms: 0, feePolicyActive: true }), reject);
  assert.equal(core.fixedFeeRejection({ chainId: 'zyron-open-testnet-1', feeAtoms: 0, launchProfile: 'legacy' }), undefined);
  assert.equal(core.fixedFeeRejection({ chainId: 'zyron-devnet-1', feeAtoms: 3, feePolicyActive: true, fixedTransferFeeAtoms: 3 }), undefined);
  assert.equal(core.fixedFeeRejection({ chainId: 'zyron-devnet-1', feeAtoms: 0, feePolicyActive: true, fixedTransferFeeAtoms: 3 }), 'This network will reject this fee. The protocol fee is 3 atoms. Nothing was signed.');
  assert.throws(() => core.zynToAtoms('50000000.00000001'), /supply/);
  for (const huge of ['999999999999', '1000000000', '99999999999.5']) assert.throws(() => core.zynToAtoms(huge), /Amount is too large/, huge);
  assert.throws(() => core.zynToAtoms('1.123456789'), /8 decimal places/);
});

await test('transfer builder: only transfers, mining_claim impossible, strict inputs', async () => {
  const account = await core.deriveAccount(core.phraseToEntropy(SNAP_VECTORS[0].mnemonic));
  const base = { version: 2, chainId: 'zyron-testnet-1', nonce: '1', receiver: SNAP_VECTORS[1].address, amountAtoms: 150000000, feeAtoms: 1000, timestampMs: 1700000000000 };
  const unsigned = core.buildTransfer(base, account);
  assert.equal(unsigned.kind, 'transfer');
  assert.equal(core.buildTransfer({ ...base, kind: 'mining_claim' }, account).kind, 'transfer', 'a kind input is ignored');
  assert.throws(() => core.signTransfer({ ...unsigned, kind: 'mining_claim' }, account.privateKey), /transfers only/);
  assert.throws(() => core.signTransfer({ ...unsigned, reward: 1 }, account.privateKey), /Unexpected/);
  assert.throws(() => core.buildTransfer({ ...base, receiver: core.MINING_TRACKER_ADDRESS }, account), /reserved system address/);
  assert.throws(() => core.buildTransfer({ ...base, receiver: account.address }, account), /differ/);
  assert.throws(() => core.buildTransfer({ ...base, chainId: 'Zyron Test' }, account), /Chain ID/);
  assert.throws(() => core.buildTransfer({ ...base, chainId: 'zyron-mainnet-1' }, account), /testnet or devnet/);
  assert.throws(() => core.buildTransfer({ ...base, chainId: 'zyron-pwa-test' }, account), /testnet or devnet/);
  assert.equal(core.buildTransfer({ ...base, chainId: core.WALLET_TESTNET_CHAIN_ID }, account).chainId, 'zyron-wallet-testnet-1');
  assert.equal(core.defaultTransferVersion('zyron-wallet-testnet-1'), 1, 'wallet testnet default version is 1');
  assert.equal(core.defaultTransferVersion(' zyron-wallet-testnet-1 '), 1);
  assert.equal(core.defaultTransferVersion('zyron-devnet'), 2);
  assert.equal(core.defaultTransferVersion('zyron-other-testnet'), 2);
  assert.equal(core.defaultTransferVersion(''), 2);
  assert.equal(core.buildTransfer({ ...base, version: core.defaultTransferVersion(core.WALLET_TESTNET_CHAIN_ID), chainId: core.WALLET_TESTNET_CHAIN_ID }, account).version, 1);
  assert.throws(() => core.buildTransfer({ ...base, nonce: '0' }, account), /Nonce/);
  assert.throws(() => core.buildTransfer({ ...base, version: 3 }, account), /version/);
  assert.throws(() => core.buildTransfer({ ...base, amountAtoms: 0 }, account), /Amount/);
  assert.throws(() => core.buildTransfer({ ...base, receiver: core.toChecksumAddress(base.receiver).replace(/[A-F]/, (c) => c.toLowerCase()) }, account), /Checksum/);
  assert.equal(core.buildTransfer({ ...base, receiver: core.toChecksumAddress(base.receiver) }, account).receiver, base.receiver);
  const other = await core.deriveAccount(core.phraseToEntropy(SNAP_VECTORS[1].mnemonic));
  assert.throws(() => core.signTransfer(unsigned, other.privateKey), /does not match/);
  for (const file of ['app.js', 'zyron-wallet-core.js', 'index.html', 'sw.js']) {
    const source = readFileSync(join(app, file), 'utf8');
    assert.doesNotMatch(source, /mining_claim['"]?\s*[,:}]|kind:\s*['"](?!transfer)/, `${file} must not build other transaction kinds`);
  }
});

const l1Dist = join(repo, 'l1', 'dist', 'src');
if (existsSync(join(l1Dist, 'transaction.js'))) {
  const l1crypto = await import(pathToFileURL(join(l1Dist, 'crypto.js')).href);
  const l1tx = await import(pathToFileURL(join(l1Dist, 'transaction.js')).href);
  const { ZyronChain } = await import(pathToFileURL(join(l1Dist, 'chain.js')).href);
  await test('l1: derived keys follow l1 address rules; signed transfers are byte-identical to l1 createTransfer and pass validation + mempool admission', async () => {
    for (const vector of SNAP_VECTORS) {
      const account = await core.deriveAccount(core.phraseToEntropy(vector.mnemonic));
      const privHex = V.bytesToHex(account.privateKey);
      assert.equal(l1crypto.publicKeyFromPrivate(privHex), vector.publicKey);
      assert.equal(l1crypto.addressFromPublicKey(vector.publicKey), vector.address);
      const receiver = vector === SNAP_VECTORS[0] ? SNAP_VECTORS[1].address : SNAP_VECTORS[0].address;
      for (const version of [1, 2]) {
        const input = { version, chainId: 'zyron-pwa-testnet', nonce: 1, receiver, amountAtoms: 250000000, feeAtoms: 1000, timestampMs: 1700000000123 };
        const tx = core.signTransfer(core.buildTransfer(input, account), account.privateKey);
        const reference = l1tx.createTransfer({ chainId: input.chainId, nonce: 1, sender: account.address, receiver, amountAtoms: input.amountAtoms, feeAtoms: input.feeAtoms, timestampMs: input.timestampMs }, privHex, account.publicKey, version);
        assert.equal(JSON.stringify(tx), JSON.stringify(reference), `v${version} byte-identical`);
        l1tx.validateTransactionShape(JSON.parse(JSON.stringify(tx)));
        const validatorPublic = l1crypto.publicKeyFromPrivate('63'.padStart(64, '0'));
        const pool = l1crypto.addressFromPublicKey(l1crypto.publicKeyFromPrivate('64'.padStart(64, '0')));
        const genesis = { chainId: input.chainId, timestampMs: 1700000000000,
          validators: [{ address: l1crypto.addressFromPublicKey(validatorPublic), publicKey: validatorPublic }],
          activityOracles: [l1crypto.publicKeyFromPrivate('65'.padStart(64, '0'))], activityPool: pool,
          allocations: [{ address: pool, amountAtoms: 0 }, { address: account.address, amountAtoms: 1000000000 }] };
        if (version === 1) {
          assert.doesNotThrow(() => new ZyronChain(genesis).validateMempoolAdmission(tx));
          assert.throws(() => new ZyronChain({ ...genesis, chainId: 'zyron-other-chain' }).validateMempoolAdmission(tx));
          assert.throws(() => l1tx.validateTransactionShape({ ...tx, amountAtoms: tx.amountAtoms + 1 }), 'tampered amount is rejected');
        }
      }
      core.wipe(account.privateKey);
    }
  });
} else if (requireL1) {
  throw new Error('l1/dist is not built (cd l1 && npm ci && npm run build)');
} else {
  console.log('skip - l1 equality (l1/dist not built)');
}

await test('ZYRON NODE wallet link: exact template only, expiry enforced, proof verifies and holds no secrets', async () => {
  const entropy = core.phraseToEntropy('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const account = await core.deriveAccount(entropy);
  const message = [
    'ZYRON NODE wallet link (TESTNET)', 'Telegram user: 4242', 'Network: zyron-wallet-testnet-1',
    'Nonce: 0123456789abcdef0123456789abcdef', 'Issued: 2026-10-12T05:00:00Z', 'Expires: 2026-10-12T05:10:00Z',
    'Signing proves you hold this testnet address. It is not a transaction: it moves no funds,',
    'grants no tokens and cannot be used on-chain.'
  ].join('\n');
  const now = Date.parse('2026-10-12T05:01:00Z');
  const request = core.parseLinkHash('#link=' + core.textToBase64Url(message), now);
  assert.equal(request.nonce, '0123456789abcdef0123456789abcdef');
  assert.equal(request.telegramUser, '4242');
  const signed = core.signLinkProof(request, account, now);
  const [prefix, nonce, publicKey, signature] = signed.proof.split('.');
  assert.equal(prefix, 'zyronlink1');
  assert.equal(nonce, request.nonce);
  assert.equal(publicKey, account.publicKey);
  assert.equal(core.addressFromPublicKey(publicKey), account.address);
  assert.ok(core.verifyCanonical({ domain: 'zyronchain/game/wallet-link/v1', payload: { message } }, signature, publicKey));
  assert.ok(!core.verifyCanonical({ domain: 'zyronchain/game/wallet-link/v1', payload: { message: message + ' ' } }, signature, publicKey));
  // Fixed vector shared with telegram-game/tests/test_wallet_proof.py (deterministic RFC 6979 signature).
  assert.equal(signature, LINK_VECTOR_SIGNATURE);
  const privHex = V.bytesToHex(account.privateKey);
  assert.ok(!signed.proof.includes(privHex), 'proof never contains the private key');
  assert.throws(() => core.signLinkProof(request, account, Date.parse('2026-10-12T05:10:00Z')), /expired/);
  for (const bad of [message.replace('TESTNET', 'MAINNET'), message.replace('zyron-wallet-testnet-1', 'zyron-mainnet-1'),
    message + '\nSend 100 ZYN', '{"kind":"transfer"}', message.replace('Nonce: 0123', 'Nonce: XYZ3')]) {
    assert.throws(() => core.parseLinkMessage(bad, now), /not a ZYRON NODE wallet link request/);
  }
  assert.equal(core.parseLinkHash('#link=%%%', now), null);
  assert.throws(() => core.parseLinkHash('#link=' + core.textToBase64Url('hello'), now), /not a ZYRON NODE/);
  assert.equal(core.parseLinkHash('#other', now), null);
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
  const html = readFileSync(join(app, 'index.html'), 'utf8');
  assert.match(html, /data-link-sign disabled/, 'link approval starts disabled');
  assert.match(appJs, /if \(!state\.linkRequest \|\| !\$\('\[data-link-ack\]'\)\.checked\) return;/);
  // No return link at all: the user switches back to the chat they opened themselves (matches the scam warning).
  assert.doesNotMatch(html, /data-link-return|t\.me\//, 'no chat link is offered after signing');
  assert.doesNotMatch(appJs, /\.href\s*=\s*[^;]*linkRequest/, 'no link target is ever taken from the request');
  core.wipe(entropy, account.privateKey);
});

await test('malformed own address: assertOwnAccount gives a clear message before sendWarnings throws (#1143)', async () => {
  const account = await core.deriveAccount(core.phraseToEntropy(core.entropyToPhrase(new Uint8Array(16).fill(7))));
  assert.equal(core.assertOwnAccount(account), account);
  const book = core.emptyBook();
  const receiver = 'ZYN' + 'ab'.repeat(20);
  for (const bad of [{ address: 'ZYN123' }, { address: '' }, { address: null }, {}, null, { address: 'ZYN' + 'g'.repeat(40) }]) {
    assert.throws(() => core.assertOwnAccount(bad), (e) => e.message === core.OWN_ADDRESS_INVALID_MESSAGE);
    if (bad) assert.throws(() => core.sendWarnings({ receiver, amountAtoms: 1 }, bad, book), 'core still fails closed on its own');
  }
  assert.doesNotMatch(core.OWN_ADDRESS_INVALID_MESSAGE, /receiver|recipient/i, 'the message is about this wallet, not the receiver');
});

await test('static scan: app code makes no network requests and has no eval/inline code; CSP is strict; SRI is complete', () => {
  const html = readFileSync(join(app, 'index.html'), 'utf8');
  for (const file of ['app.js', 'zyron-wallet-core.js', 'vendor/noble-scure.js', 'vendor/qr.js']) {
    const source = readFileSync(join(app, file), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|importScripts|\bimport\s*\(/, `${file} must not do network I/O`);
    assert.doesNotMatch(source, /\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]/, `${file} must not evaluate strings`);
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/, `${file} must not use other storage`);
  }
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
  assert.match(appJs, /core\.assertVaultShape\(vault\); \/\/ refuses to persist/, 'only encrypted vaults reach IndexedDB');
  assert.equal((appJs.match(/store\.put\(/g) || []).length, 1, 'exactly one IndexedDB write path');
  assert.doesNotMatch(appJs, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'no HTML injection sinks');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "frame-src 'none'", "form-action 'none'", "worker-src 'self'", "manifest-src 'self'"]) assert.ok(csp.includes(directive), directive);
  assert.match(html, /data-tx-fee[^>]*value="0\.001"/, 'send form fills the 0.001 ZYN protocol fee');
  assert.match(readFileSync(join(app, 'app.js'), 'utf8'), /FIXED_TRANSFER_FEE_ATOMS/, 'an empty fee field falls back to the protocol fee');
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|wasm-unsafe-eval|\*|https?:|data:|blob:/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
  assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i, 'no inline styles or event handlers');
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(scripts.length, 4);
  for (const tag of [...scripts, html.match(/<link rel="stylesheet"[^>]*>/)[0]]) {
    const [, src, v] = tag.match(/(?:src|href)="\/app\/([^"?]+)\?v=([0-9a-f]{12})"/);
    assert.equal(v, createHash('sha256').update(readFileSync(join(app, src))).digest('hex').slice(0, 12), `content version for ${src}`);
    const [, integrity] = tag.match(/integrity="(sha384-[^"]+)"/);
    assert.equal(integrity, 'sha384-' + createHash('sha384').update(readFileSync(join(app, src))).digest('base64'), `SRI for ${src}`);
  }
  assert.ok(html.indexOf('vendor/noble-scure.js') < html.indexOf('zyron-wallet-core.js') && html.indexOf('zyron-wallet-core.js') < html.indexOf('/app/app.js'));
  assert.doesNotMatch(html, /(?:src|href)="\.\.?\//, 'absolute /app/ paths so /app (no slash) also works');
  const vendor = JSON.parse(readFileSync(join(app, 'vendor', 'VENDOR.json'), 'utf8'));
  for (const bundle of vendor.bundles) {
    assert.equal(bundle.integrity, 'sha384-' + createHash('sha384').update(readFileSync(join(app, 'vendor', bundle.file))).digest('base64'));
    for (const p of bundle.packages) assert.match(p.version, /^\d+\.\d+\.\d+$/, 'pinned exact version');
  }
  const curves = vendor.bundles[0].packages.find((p) => p.name === '@noble/curves');
  const l1Lock = JSON.parse(readFileSync(join(repo, 'l1', 'package-lock.json'), 'utf8')).packages['node_modules/@noble/curves'];
  assert.equal(curves.integrity, l1Lock.integrity, 'same @noble/curves tarball as l1');
});

await test('service worker: same-origin GET of listed shell files only, versioned cache, integrity-checked install, never touches IndexedDB', () => {
  const sw = readFileSync(join(app, 'sw.js'), 'utf8');
  assert.match(sw, /if \(request\.method !== 'GET'\) return;/);
  assert.match(sw, /if \(url\.origin !== self\.location\.origin \|\| url\.hash\) return;/);
  assert.match(sw, /let key = url\.pathname \+ url\.search;/, 'exact path + version query match');
  assert.match(sw, /if \(!SHELL_KEYS\.has\(key\)\) return;/);
  // update flow: updates wait for the page's explicit request; only that one message is understood
  assert.match(sw, /if \(!self\.registration\.active\) await self\.skipWaiting\(\);/);
  assert.equal((sw.match(/skipWaiting\(\)/g) || []).length, 2);
  assert.match(sw, /event\.data === 'zyron-skip-waiting' && event\.source && new URL\(event\.source\.url\)\.origin === self\.location\.origin/);
  assert.match(sw, /const CACHE = 'zyron-wallet-app-' \+ VERSION;/);
  assert.match(sw, /failed its integrity check/);
  assert.doesNotMatch(sw, /indexedDB|localStorage|postMessage|importScripts|clients\.matchAll/);
  assert.equal((sw.match(/cache\.put\(/g) || []).length, 1, 'only the install step writes to the cache');
  const assets = JSON.parse(sw.match(/const ASSETS = (\{[\s\S]*?\});/)[1]);
  for (const [entry, sha256] of Object.entries(assets)) {
    assert.ok(entry.startsWith('./') && !entry.includes('..'), entry);
    const [path, query] = entry.split('?');
    if (sha256 === null) { assert.match(path, /\.png$/, 'only icons may skip the hash check'); continue; }
    const digest = createHash('sha256').update(readFileSync(join(app, path))).digest('hex');
    assert.equal(digest, sha256, `stamped hash for ${entry}`);
    if (query) assert.equal(query, 'v=' + digest.slice(0, 12), `version query for ${entry}`);
  }
  assert.ok(assets['./index.html'] && Object.keys(assets).some((k) => k.startsWith('./vendor/noble-scure.js?v=')) && Object.keys(assets).some((k) => k.startsWith('./app.js?v=')));
  // build id: stamped meta matches the worker version and the canonical release reference
  const html = readFileSync(join(app, 'index.html'), 'utf8');
  const release = readFileSync(join(repo, 'website', 'release.js'), 'utf8').match(/const RELEASE_REF = '([0-9a-f]{40})';/)[1];
  const version = sw.match(/const VERSION = '([0-9a-f]{16})';/)[1];
  assert.ok(html.includes(`<meta name="zyron-build" content="app=${version};release=${release}" />`), 'build id meta');
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
  assert.match(appJs, /'Build ' \+ appBuild \+ ' · release ' \+ release/);
  assert.match(appJs, /registration\.waiting\.postMessage\('zyron-skip-waiting'\)/);
  assert.match(appJs, /if \(updateRequested\) window\.location\.reload\(\);/);
  assert.ok(html.includes('A new Zyron Wallet version is available.') && html.includes('Update now'));
});

function pngSize(file) {
  const bytes = readFileSync(file);
  assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a', `${file} is PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}
await test('web app manifest is valid and installable (name, scope, standalone, 192/512 + maskable icons, apple-touch-icon)', () => {
  const manifest = JSON.parse(readFileSync(join(app, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'ZyronChain Wallet');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/app/');
  assert.ok(manifest.start_url.startsWith(manifest.scope));
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.equal(manifest.prefer_related_applications, false);
  const need = new Set(['192x192:any', '512x512:any', '192x192:maskable', '512x512:maskable']);
  for (const icon of manifest.icons) {
    const [w, h] = pngSize(join(repo, 'website', icon.src));
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    need.delete(`${icon.sizes}:${icon.purpose}`);
  }
  assert.equal(need.size, 0, 'missing icons: ' + [...need].join(', '));
  const html = readFileSync(join(app, 'index.html'), 'utf8');
  for (const marker of ['rel="manifest" href="/app/manifest.json"', 'rel="apple-touch-icon" sizes="180x180"', 'name="apple-mobile-web-app-capable" content="yes"', 'name="theme-color"', 'viewport-fit=cover']) assert.ok(html.includes(marker), marker);
  assert.deepEqual(pngSize(join(app, 'icons', 'apple-touch-icon-180.png')), [180, 180]);
  for (const marker of ['TESTNET', 'Scam warning', 'does not show a balance', 'unaudited', 'Add to Home Screen', 'Install app', 'Open in Safari', 'zyron-wallet-testnet-1', "Balance isn't shown in this offline app", "use the network's current nonce + 1 (1 for a new account)", 'href="/testnet/"']) assert.ok(html.includes(marker), marker);
  assert.doesNotMatch(html, /empty-well|>--</, 'no balance placeholder');
  assert.doesNotMatch(html.slice(html.indexOf('data-balance-card'), html.indexOf('data-screen="send"')), /\d+(?:\.\d+)?\s*ZYN/, 'balance card shows no amount');
  const appSource = readFileSync(join(app, 'app.js'), 'utf8');
  assert.match(appSource, /\[data-copy-address\]'\)\.addEventListener\([\s\S]*?copyText\(state\.account\.address/, 'primary copy is the canonical lowercase address');
  assert.match(appSource, /defaultTransferVersion/);
  assert.ok(html.indexOf('data-install') < html.indexOf('data-network-status'), 'install guidance is above the network status table');
  assert.doesNotMatch(html, /No public RPC yet/);
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
  assert.match(appJs, /IN_APP_RE/);
  assert.match(appJs, /Telegram/);
  // English-only UI: no language toggle, no second dictionary, no locale auto-detect, no accented/non-English letters.
  for (const banned of ['data-lang-toggle', 'navigator.language', 'navigator.languages', 'hreflang', 'Intl.DateTimeFormat().resolvedOptions']) {
    assert.ok(!html.includes(banned), `index.html contains ${banned}`);
    assert.ok(!appJs.includes(banned), `app.js contains ${banned}`);
  }
  assert.deepEqual([...html.matchAll(/\blang="([^"]+)"/g)].map((m) => m[1]), ['en'], 'only lang="en"');
  assert.doesNotMatch(appJs, /\b[a-z]{2}: \{\n/, 'no second-language dictionary in app.js');
  assert.doesNotMatch(html + appJs, /[\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0600-\u06FF]/, 'non-English letters in the app UI');
  const keys = [...html.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)</g)];
  const english = new Map();
  for (const [, key, text] of keys) { if (english.has(key)) assert.equal(english.get(key), text, `UI key ${key} reused with different text`); english.set(key, text); }
  assert.deepEqual(readdirSync(join(app, 'vendor')).sort(), ['LICENSES.txt', 'VENDOR.json', 'noble-scure.js', 'qr.js']);
});

console.log(`pwa-core tests passed: ${passed}`);

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
    [{ ...vault, version: 2 }, /version/],
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
  assert.deepEqual(core.parseVault(JSON.stringify(vault)), vault, 'JSON text is accepted when it is exactly a v1 vault');
  const bad = [
    [null, /plain object/], [undefined, /plain object/], [42, /plain object/], ['not json', /valid JSON/], ['[]', /plain object/],
    ['x'.repeat(5000), /too large/], [[vault], /plain object/],
    [Object.assign(Object.create({ evil: true }), vault), /plain object/],
    [{ ...vault, version: 0 }, /version/], [{ ...vault, version: 2 }, /version/], [{ ...vault, version: '1' }, /version/], [{ ...vault, version: 1.5 }, /version/],
    [{ ...vault, format: 'zyronchain-pwa-vault-v2' }, /format/],
    [{ ...vault, createdAt: 'yesterday' }, /creation time/], [{ ...vault, createdAt: 12 }, /creation time/],
    [{ ...vault, words: '12' }, /word count/],
    [{ ...vault, kdf: [] }, /KDF/], [{ ...vault, kdf: { ...vault.kdf, extra: 1 } }, /KDF/],
    [{ ...vault, cipher: { ...vault.cipher, name: 'aes-128-gcm' } }, /cipher/], [{ ...vault, cipher: 'aes' }, /cipher/],
    [{ ...vault, salt: 'zz' }, /salt/], [{ ...vault, ciphertext: 'ABC' }, /ciphertext/],
    [(({ createdAt, ...rest }) => rest)(vault), /unexpected fields/], [{ ...vault, __proto__: null, extra: 1 }, /unexpected fields/]
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
  const unsigned = core.buildTransfer({ version: 2, chainId: 'zyron-review-test', nonce: 7, receiver: 'ZYN5D99EE966b42cD8fC7bdD1364B389153A9E78B42', amountAtoms: 150000000, feeAtoms: 1000, timestampMs: 1700000000000 }, account);
  const rows = core.describeTransfer(unsigned);
  assert.deepEqual(rows.map((r) => r.key), ['type', 'from', 'to', 'amount', 'fee', 'chain', 'nonce', 'time']);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  assert.match(byKey.type, /^Transfer \(kind "transfer", version 2\)$/);
  assert.equal(byKey.from, core.toChecksumAddress(account.address));
  assert.equal(byKey.to, 'ZYN5D99EE966b42cD8fC7bdD1364B389153A9E78B42');
  assert.equal(byKey.amount, '1.5 ZYN (150000000 atoms)');
  assert.equal(byKey.fee, '0.00001 ZYN (1000 atoms)');
  assert.equal(byKey.chain, 'zyron-review-test');
  assert.equal(byKey.nonce, '7');
  for (const [bad, pattern] of [
    [{ ...unsigned, kind: 'mining_claim' }, /transfers only/], [{ ...unsigned, kind: 'message' }, /transfers only/], [{ ...unsigned, kind: undefined }, /transfers only/],
    [{ ...unsigned, memo: 'x' }, /Unexpected transfer fields/], [{ ...unsigned, data: '0x' }, /Unexpected transfer fields/],
    [{ ...unsigned, version: 3 }, /version/], [{ ...unsigned, chainId: '' }, /Chain ID/], [{ ...unsigned, nonce: 0 }, /Nonce/],
    [{ ...unsigned, receiver: core.MINING_TRACKER_ADDRESS }, /mining tracker/], [{ ...unsigned, sender: 'ZYN' + '1'.repeat(40) }, /Sender does not match/],
    [JSON.stringify(unsigned), /Nothing to review/], [['transfer'], /Nothing to review/]
  ]) {
    assert.throws(() => core.describeTransfer(bad), pattern);
    assert.throws(() => core.signTransfer(bad, account.privateKey), /transfers only|Unexpected|version|Chain ID|Nonce|mining tracker|Sender|Nothing/);
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
  assert.match(html, /JavaScript cannot guarantee that memory is erased/);
  // copy is only offered for the address and a signed transfer
  const copyButtons = [...html.matchAll(/<button\b[^>]*>[^<]*<\/button>/g)].map((m) => m[0]).filter((b) => /copy/i.test(b)).map((b) => b.match(/data-([a-z-]+)/)[1]).sort();
  assert.deepEqual(copyButtons, ['copy-address', 'copy-plain', 'tx-copy']);
  assert.ok(appJs.includes("msgCopied: 'Copied. Clipboard will be cleared automatically.'"));
});

await test('network status component: static, honest rows, identical everywhere it is used', async () => {
  const { ROWS, render } = await import(pathToFileURL(join(repo, 'tools', 'site', 'network-status.mjs')).href);
  const expected = { governance: 'Authorized', 'public-testnet': 'Not activated', 'public-rpc': 'Unavailable', explorer: 'Unavailable', 'wallet-creation': 'Available locally', 'offline-signing': 'Available', broadcasting: 'Unavailable until activation', mining: 'Retired', 'token-sale': 'None' };
  assert.deepEqual(Object.fromEntries(ROWS.map((r) => [r.key, r.value])), expected);
  const block = render();
  for (const page of ['website/app/index.html', 'website/index.html', 'website/wallet.html']) {
    const file = join(repo, page);
    if (!existsSync(file)) continue;
    const html = readFileSync(file, 'utf8');
    if (!html.includes('BEGIN NETWORK STATUS')) { assert.notEqual(page, 'website/app/index.html', 'the phone wallet shows network status'); continue; }
    const got = html.match(/<!-- BEGIN NETWORK STATUS[\s\S]*?<!-- END NETWORK STATUS -->/)[0].split('\n').map((l) => l.trim()).join('\n');
    assert.equal(got, block.split('\n').map((l) => l.trim()).join('\n'), `${page} network status is stale`);
  }
  assert.doesNotMatch(block, /mainnet (is )?live|activated public testnet|public rpc: available|buy now|price target|\$\s?\d/i);
  assert.doesNotMatch(block, /https?:\/\/(?!github\.com)/, 'no endpoints');
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
  assert.throws(() => core.zynToAtoms('50000000.00000001'), /supply/);
});

await test('transfer builder: only transfers, mining_claim impossible, strict inputs', async () => {
  const account = await core.deriveAccount(core.phraseToEntropy(SNAP_VECTORS[0].mnemonic));
  const base = { version: 2, chainId: 'zyron-test-1', nonce: '1', receiver: SNAP_VECTORS[1].address, amountAtoms: 150000000, feeAtoms: 1000, timestampMs: 1700000000000 };
  const unsigned = core.buildTransfer(base, account);
  assert.equal(unsigned.kind, 'transfer');
  assert.equal(core.buildTransfer({ ...base, kind: 'mining_claim' }, account).kind, 'transfer', 'a kind input is ignored');
  assert.throws(() => core.signTransfer({ ...unsigned, kind: 'mining_claim' }, account.privateKey), /transfers only/);
  assert.throws(() => core.signTransfer({ ...unsigned, reward: 1 }, account.privateKey), /Unexpected/);
  assert.throws(() => core.buildTransfer({ ...base, receiver: core.MINING_TRACKER_ADDRESS }, account), /mining tracker/);
  assert.throws(() => core.buildTransfer({ ...base, receiver: account.address }, account), /differ/);
  assert.throws(() => core.buildTransfer({ ...base, chainId: 'Zyron Test' }, account), /Chain ID/);
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
        const input = { version, chainId: 'zyron-pwa-test', nonce: 1, receiver, amountAtoms: 250000000, feeAtoms: 1000, timestampMs: 1700000000123 };
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
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|wasm-unsafe-eval|\*|https?:|data:|blob:/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
  assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i, 'no inline styles or event handlers');
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(scripts.length, 4);
  for (const tag of [...scripts, html.match(/<link rel="stylesheet"[^>]*>/)[0]]) {
    const [, src] = tag.match(/(?:src|href)="\/app\/([^"]+)"/);
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
  assert.match(sw, /if \(url\.origin !== self\.location\.origin \|\| url\.search \|\| url\.hash\) return;/);
  assert.match(sw, /if \(!SHELL_PATHS\.has\(path\)\) return;/);
  assert.match(sw, /const CACHE = 'zyron-wallet-app-' \+ VERSION;/);
  assert.match(sw, /failed its integrity check/);
  assert.doesNotMatch(sw, /indexedDB|localStorage|postMessage|importScripts|clients\.matchAll/);
  assert.equal((sw.match(/cache\.put\(/g) || []).length, 1, 'only the install step writes to the cache');
  const assets = JSON.parse(sw.match(/const ASSETS = (\{[\s\S]*?\});/)[1]);
  for (const [path, sha256] of Object.entries(assets)) {
    assert.ok(path.startsWith('./') && !path.includes('..'), path);
    if (sha256 === null) { assert.match(path, /\.png$/, 'only icons may skip the hash check'); continue; }
    assert.equal(createHash('sha256').update(readFileSync(join(app, path))).digest('hex'), sha256, `stamped hash for ${path}`);
  }
  assert.ok(assets['./index.html'] && assets['./vendor/noble-scure.js'] && assets['./app.js']);
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
  for (const marker of ['TESTNET', 'Scam warning', 'No public RPC yet', 'unaudited', 'Add to Home Screen', 'Install app']) assert.ok(html.includes(marker), marker);
  const appJs = readFileSync(join(app, 'app.js'), 'utf8');
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

/*
 * ZyronChain wallet page helpers. Public data only.
 *
 * Nothing in this file accepts, generates, stores or transmits a private key,
 * password or keystore. It mirrors the public L1 rules in l1/src/crypto.ts:
 *   address = "ZYN" + first 40 hex chars of SHA-256(uncompressed secp256k1
 *   public key without the 0x04 prefix, 64 bytes)
 * and is cross-checked against the L1 implementation by
 * website/test-wallet-core.mjs.
 */
(function (root) {
  'use strict';

  const ADDRESS_RE = /^ZYN[0-9a-f]{40}$/;
  const PUBLIC_KEY_RE = /^[0-9a-f]{128}$/;
  const ATOMS_PER_ZYN = 100000000n;
  // Fixed-supply design: 50,000,000 ZYN. Used only to reject absurd inputs.
  const MAX_SUPPLY_ATOMS = 50000000n * ATOMS_PER_ZYN;
  const SECP256K1_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

  function isValidAddress(value) {
    return typeof value === 'string' && ADDRESS_RE.test(value);
  }

  // Explains why an address is invalid, in plain language, without guessing a "fix".
  function explainAddress(value) {
    if (typeof value !== 'string' || value.length === 0) return 'Enter an address.';
    if (value !== value.trim()) return 'Remove spaces before or after the address.';
    if (/^zyn/i.test(value) && !value.startsWith('ZYN')) return 'The prefix must be upper-case ZYN.';
    if (!value.startsWith('ZYN')) return 'A ZyronChain address starts with ZYN.';
    const body = value.slice(3);
    if (/[A-F]/.test(body)) return 'After ZYN the address uses lower-case hex only (0-9, a-f).';
    if (/[^0-9a-f]/.test(body)) return 'After ZYN only the characters 0-9 and a-f are allowed.';
    if (body.length !== 40) return `After ZYN there must be exactly 40 characters (found ${body.length}).`;
    return '';
  }

  // Splits an address into 4-character groups for side-by-side visual comparison.
  function groupAddress(address) {
    if (!isValidAddress(address)) throw new Error('Invalid ZyronChain address');
    const body = address.slice(3).match(/.{4}/g);
    return ['ZYN', ...body].join(' ');
  }

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function modPow(base, exponent, modulus) {
    let result = 1n;
    let value = base % modulus;
    let power = exponent;
    while (power > 0n) {
      if (power & 1n) result = (result * value) % modulus;
      value = (value * value) % modulus;
      power >>= 1n;
    }
    return result;
  }

  // True when x||y (128 hex, no 04 prefix) is a point on secp256k1 (y^2 = x^3 + 7 mod p).
  function isOnSecp256k1(publicKeyHex) {
    if (typeof publicKeyHex !== 'string' || !PUBLIC_KEY_RE.test(publicKeyHex)) return false;
    const x = BigInt(`0x${publicKeyHex.slice(0, 64)}`);
    const y = BigInt(`0x${publicKeyHex.slice(64)}`);
    if (x >= SECP256K1_P || y >= SECP256K1_P) return false;
    const left = (y * y) % SECP256K1_P;
    const right = (modPow(x, 3n, SECP256K1_P) + 7n) % SECP256K1_P;
    return left === right;
  }

  function normalizePublicKey(value) {
    if (typeof value !== 'string') throw new Error('Public key must be text');
    let hex = value.trim().toLowerCase();
    if (hex.startsWith('0x')) hex = hex.slice(2);
    // Accept the SEC1 uncompressed form (04 || x || y) as well as the L1 form (x || y).
    if (hex.length === 130 && hex.startsWith('04')) hex = hex.slice(2);
    if (!PUBLIC_KEY_RE.test(hex)) {
      throw new Error('Expected an uncompressed secp256k1 public key: 128 hex characters (x||y), as printed by the ZyronChain CLI');
    }
    if (!isOnSecp256k1(hex)) throw new Error('This is not a valid secp256k1 public key (point is not on the curve)');
    return hex;
  }

  function subtleCrypto() {
    const subtle = root.crypto && root.crypto.subtle;
    if (!subtle) throw new Error('This browser does not provide Web Crypto SHA-256');
    return subtle;
  }

  async function addressFromPublicKey(publicKeyInput) {
    const publicKey = normalizePublicKey(publicKeyInput);
    const digest = await subtleCrypto().digest('SHA-256', hexToBytes(publicKey));
    return `ZYN${bytesToHex(new Uint8Array(digest)).slice(0, 40)}`;
  }

  // Exact decimal ZYN -> integer atoms (8 decimals), with no floating point.
  function zynToAtoms(value) {
    if (typeof value !== 'string') throw new Error('Amount must be text');
    const text = value.trim().replace(/_/g, '');
    const match = /^(\d{1,9})(?:\.(\d{1,8}))?$/.exec(text);
    if (!match) throw new Error('Use a plain decimal ZYN amount with at most 8 decimal places, e.g. 1.5');
    const atoms = BigInt(match[1]) * ATOMS_PER_ZYN + BigInt((match[2] || '').padEnd(8, '0') || '0');
    if (atoms > MAX_SUPPLY_ATOMS) throw new Error('Amount exceeds the 50,000,000 ZYN fixed-supply design');
    return atoms.toString();
  }

  function atomsToZyn(value) {
    const text = typeof value === 'bigint' ? value.toString() : String(value);
    if (!/^\d{1,16}$/.test(text)) throw new Error('Atoms must be a non-negative integer');
    const atoms = BigInt(text);
    const whole = atoms / ATOMS_PER_ZYN;
    const fraction = (atoms % ATOMS_PER_ZYN).toString().padStart(8, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  }

  // Builds the CLI transfer template. RPC and chain ID stay placeholders until they are
  // officially published; this function never invents an endpoint.
  function buildTransferCommand(input) {
    const receiver = input && input.receiver;
    if (!isValidAddress(receiver)) throw new Error('Receiver must be a valid ZyronChain address');
    const amountAtoms = zynToAtoms(input.amountZyn);
    if (amountAtoms === '0') throw new Error('Amount must be greater than zero');
    const feeAtoms = String(input.feeAtoms === undefined || input.feeAtoms === '' ? '1000' : input.feeAtoms).trim();
    if (!/^\d{1,12}$/.test(feeAtoms)) throw new Error('Fee must be a whole number of atoms');
    return [
      'export ZYRON_KEYSTORE_PASSWORD_FILE=/secure/path/wallet.password',
      'node dist/src/cli.js transfer \\',
      '  --key wallet.json \\',
      '  --rpc <PUBLIC_WALLET_RPC_WHEN_PUBLISHED> \\',
      '  --chain-id <CANONICAL_CHAIN_ID> \\',
      `  --to ${receiver} \\`,
      `  --amount-atoms ${amountAtoms} \\`,
      `  --fee-atoms ${feeAtoms}`
    ].join('\n');
  }

  // Local restore test: decrypts the keystore with the password file inside Node, checks the
  // decrypted key re-derives the stored public key + address, and prints only the address.
  // The private key is never printed, written or sent anywhere.
  const RESTORE_CHECK_JS = [
    "const fs=require('node:fs');",
    "(async()=>{",
    "const ks=await import(require('node:url').pathToFileURL(require('node:path').resolve('dist/src/keystore.js')).href);",
    "const w=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));",
    "const pw=ks.normalizePasswordFile(fs.readFileSync(process.argv[2],'utf8'));",
    "ks.decryptPrivateKey(w,pw);",
    "console.log('Restore test passed. Keystore decrypts and matches address '+w.address);",
    "})().catch((e)=>{console.error('Restore test FAILED: '+(e&&e.message||e));process.exit(1);});"
  ].join('');

  root.ZyronWalletCore = Object.freeze({
    ADDRESS_RE,
    PUBLIC_KEY_RE,
    ATOMS_PER_ZYN,
    MAX_SUPPLY_ATOMS,
    RESTORE_CHECK_JS,
    isValidAddress,
    explainAddress,
    groupAddress,
    isOnSecp256k1,
    normalizePublicKey,
    addressFromPublicKey,
    zynToAtoms,
    atomsToZyn,
    buildTransferCommand
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

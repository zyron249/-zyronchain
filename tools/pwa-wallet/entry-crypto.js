// Entry for website/app/vendor/noble-scure.js. Exposes only what the PWA needs.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';

globalThis.ZyronVendor = Object.freeze({
  secp256k1,
  sha256,
  sha512,
  scryptAsync,
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  bip39: Object.freeze({ entropyToMnemonic, mnemonicToEntropy, mnemonicToSeed, validateMnemonic, wordlist }),
  HDKey
});

// Leak check for a stored PWA wallet vault, shared by the Node and browser tests.
//
// The vault schema is fixed (assertVaultShape pins every key and the constant values below), and some BIP-39
// words occur inside that fixed text: address, dress (in "address"), public (in "publicKey"), vault (in the
// format) and version. Searching the raw JSON for every recovery-phrase word therefore failed for about 3% of
// random phrases without any leak. This helper blanks only schema keys and the pinned constants in their own
// positions, then searches what is left. A secret inside any value, an unknown key, or a schema token used as
// a variable value is still reported.
const KEYS = new Set([
  'address', 'cipher', 'ciphertext', 'createdAt', 'derivationPath', 'format', 'kdf', 'publicKey', 'salt', 'version', 'words',
  'iv', 'name', 'n', 'r', 'p', 'dkLen',
]);
const TOP_CONSTANTS = new Map([['format', 'zyronchain-pwa-vault'], ['derivationPath', "m/44'/249249'/0'/0/0"]]);
const NAME_CONSTANTS = new Map([['kdf', 'scrypt'], ['cipher', 'aes-256-gcm']]);

function residualText(value, path) {
  if (Array.isArray(value)) return '[' + value.map((v) => residualText(v, path)).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).map(([key, v]) => (KEYS.has(key) ? '""' : JSON.stringify(key)) + ':' + residualText(v, [...path, key])).join(',') + '}';
  }
  if (typeof value === 'string') {
    if (path.length === 1 && TOP_CONSTANTS.get(path[0]) === value) return '""';
    if (path.length === 2 && path[1] === 'name' && NAME_CONSTANTS.get(path[0]) === value) return '""';
  }
  return JSON.stringify(value);
}

// Returns the secrets that appear anywhere in the vault outside the fixed schema text.
export function vaultSecretLeaks(vault, secrets) {
  const text = residualText(vault, []);
  return secrets.filter((secret) => secret && text.includes(secret));
}

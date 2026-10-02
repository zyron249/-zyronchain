/**
 * Dependency-free constants shared by the Snap and its tests.
 *
 * Keep this file free of imports so Jest (CommonJS) can load it directly.
 */

/**
 * PROVISIONAL coin type. ZyronChain has NO registered SLIP-44 coin type.
 * 249249 was unassigned in satoshilabs/slips `slip-0044.md` at commit
 * 570ed55b7fde158f1116be34fc2faa35dada5912 (checked 2026-09-30). Before any
 * release this must be replaced by a registered SLIP-44 value (or the project
 * must formally adopt this custom path). Changing it changes every address.
 */
export const PROVISIONAL_COIN_TYPE = 249249;

/**
 * BIP-32 path of the single ZyronChain account this Snap exposes:
 * m / 44' / 249249' / 0' / 0 / 0  (BIP-44 layout: account 0, external chain, index 0).
 * The manifest grants snap_getBip32Entropy for exactly this path, so the Snap
 * cannot derive any other key from the Secret Recovery Phrase.
 */
export const DERIVATION_PATH = [
  'm',
  "44'",
  `${PROVISIONAL_COIN_TYPE}'`,
  "0'",
  '0',
  '0',
] as const;

export const DERIVATION_PATH_STRING = DERIVATION_PATH.join('/');

/** Origins allowed to call the Snap (mirrors `endowment:rpc.allowedOrigins`). */
export const ALLOWED_ORIGINS: readonly string[] = [
  'https://zyronchain.com',
  // Local development only. Remove before any listing/production release.
  'http://localhost:8000',
];

/** Mirrors l1/src/types.ts. */
export const ATOMS_PER_ZYN = 100_000_000;
export const MAX_SUPPLY_ATOMS = 50_000_000 * ATOMS_PER_ZYN;

/** Mirrors l1/src/mining.ts MINING_TRACKER_ADDRESS (protocol-reserved). */
export const MINING_TRACKER_ADDRESS = `ZYN${'0'.repeat(40)}`;

/** Mirrors l1 transactionSigningDomain("transfer"). */
export const TRANSFER_SIGNING_DOMAIN_V2 = 'zyronchain/transaction/transfer/v2';

/**
 * Domain for off-chain message signing. It is signed through the same
 * l1 `signCanonicalDomain` construction, i.e. over canonicalJson({ domain,
 * payload }), and is distinct from every l1 transaction/governance/consensus
 * domain. See README "Message signing and domain separation".
 */
export const MESSAGE_SIGNING_DOMAIN = 'zyronchain/snap/personal-message/v1';

export const MAX_MESSAGE_LENGTH = 1024;

/** l1 genesis chain ID rule (validateGenesis in l1/src/chain.ts). */
export const CHAIN_ID_PATTERN = /^[a-z0-9-]{3,64}$/u;

export const ADDRESS_PATTERN = /^ZYN[0-9a-f]{40}$/u;

export const RPC_METHODS = {
  getAddress: 'zyron_getAddress',
  signTransaction: 'zyron_signTransaction',
  signMessage: 'zyron_signMessage',
} as const;

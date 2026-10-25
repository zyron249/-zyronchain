/**
 * Feature 6A, option 3 (Patron decision on PR #1146) with the Security ruling: the transfer
 * transaction version is chosen from the chain's ADVERTISED protocol, never from a user toggle,
 * flag, environment variable or payload field, and the l1 CLI never signs version 1.
 *
 * - Online: the node's reported next protocol version (RPC /protocol).
 * - Offline: the fixed table OFFLINE_CHAIN_PROTOCOLS below; an unknown chain is treated as
 *   v2-capable (protocol 3), never as version 1.
 * - Protocol < 3 (a version-1 chain) is refused with a pointer to issue #1147. The only version-1
 *   exception is in the PWA (zyron-wallet-testnet-1, time-boxed); see
 *   docs/design/feature-6a-intent-renderer.md.
 *
 * Pure: no I/O, no environment, no configuration. It never changes what consensus accepts.
 */
import { IntentRenderRefusal } from "./intent-render.js";

/** Version 2 (domain-separated signatures) is required from this protocol version onward. */
export const FIRST_V2_PROTOCOL = 3;

export const V1_RETIREMENT_ISSUE = "https://github.com/zyron249/-zyronchain/issues/1147";

/**
 * Advertised protocol per known chain ID, for offline signing. Pinned by
 * l1/test/transfer-version-policy.test.ts; edit both together with the chain's operators.
 * - zyron-wallet-testnet-1: protocol 1 (l1/scripts/public-testnet-rpc.mjs); refused until #1147.
 * - zyron-open-testnet-1: protocol 6 after its bootstrap activation (l1/scripts/open-testnet.mjs).
 * - zyron-devnet-1: not listed, so it is treated as v2-capable (protocol 3).
 */
export const OFFLINE_CHAIN_PROTOCOLS: Readonly<Record<string, number>> = Object.freeze({
  "zyron-wallet-testnet-1": 1,
  "zyron-open-testnet-1": 6
});

/** Offline: the protocol a chain advertises according to the fixed table (unknown means v2-capable). */
export function offlineProtocolForChain(
  chainId: string,
  table: Readonly<Record<string, unknown>> = OFFLINE_CHAIN_PROTOCOLS
): unknown {
  return Object.hasOwn(table, chainId) ? table[chainId] : FIRST_V2_PROTOCOL;
}

/**
 * Returns 2 for a chain whose advertised protocol is v2-capable and refuses everything else.
 * `requested` (an optional --tx-version) may only confirm the result, never change it.
 */
export function resolveTransferVersion(
  chainId: string,
  advertisedProtocol: unknown,
  source: "node" | "offline-table",
  requested?: number
): 2 {
  if (typeof advertisedProtocol !== "number" || !Number.isSafeInteger(advertisedProtocol) || advertisedProtocol < 1) {
    throw new IntentRenderRefusal(`the ${source} protocol version for ${chainId} is invalid. Nothing was signed.`);
  }
  if (advertisedProtocol < FIRST_V2_PROTOCOL) {
    throw new IntentRenderRefusal(
      `${chainId} advertises protocol ${advertisedProtocol} (${source}), which needs transaction version 1; ` +
      `the CLI never signs version 1. Use a protocol-3 chain; see ${V1_RETIREMENT_ISSUE}. Nothing was signed.`
    );
  }
  if (requested !== undefined && requested !== 2) {
    throw new IntentRenderRefusal(`tx-version ${requested} is refused: ${chainId} advertises protocol ${advertisedProtocol} (${source}), which requires version 2, and the version cannot be overridden. Nothing was signed.`);
  }
  return 2;
}

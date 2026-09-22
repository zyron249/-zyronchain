import { canonicalizePublicTestnetBootstrapPeer, PUBLIC_TESTNET_MIN_FAILURE_DOMAINS } from "./public-testnet-identity.js";
import { assertExactKeys, assertPlainRecord } from "./transaction.js";

export const PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER = "PLACEHOLDER";

const SLOT_KEYS = [
  "slot",
  "failureDomainEnv",
  "peerIdEnv",
  "multiaddrEnv",
  "failureDomain",
  "peerId",
  "multiaddr"
] as const;

const FILE_KEYS = [
  "schemaVersion",
  "status",
  "networkClass",
  "live",
  "environmentIgnored",
  "slots"
] as const;

const UNFILLED_SLOTS = [
  {
    slot: "bootstrap-a",
    failureDomainEnv: "ZYRON_PUBLIC_TESTNET_BOOTSTRAP_A_FAILURE_DOMAIN",
    peerIdEnv: "ZYRON_PUBLIC_TESTNET_BOOTSTRAP_A_PEER_ID",
    multiaddrEnv: "ZYRON_PUBLIC_TESTNET_BOOTSTRAP_A_MULTIADDR"
  },
  {
    slot: "bootstrap-b",
    failureDomainEnv: "ZYRON_PUBLIC_TESTNET_BOOTSTRAP_B_FAILURE_DOMAIN",
    peerIdEnv: "ZYRON_PUBLIC_TESTNET_BOOTSTRAP_B_PEER_ID",
    multiaddrEnv: "ZYRON_PUBLIC_TESTNET_BOOTSTRAP_B_MULTIADDR"
  },
  {
    slot: "bootstrap-c",
    failureDomainEnv: "ZYRON_PUBLIC_TESTNET_BOOTSTRAP_C_FAILURE_DOMAIN",
    peerIdEnv: "ZYRON_PUBLIC_TESTNET_BOOTSTRAP_C_PEER_ID",
    multiaddrEnv: "ZYRON_PUBLIC_TESTNET_BOOTSTRAP_C_MULTIADDR"
  }
] as const;

export interface PublicTestnetBootstrapSlot {
  slot: string;
  failureDomainEnv: string;
  peerIdEnv: string;
  multiaddrEnv: string;
  failureDomain: string;
  peerId: string;
  multiaddr: string;
}

export interface PublicTestnetBootstrapConfig {
  schemaVersion: 1;
  status: "proposal-unfilled" | "bootstrap-ready";
  networkClass: "public-testnet";
  live: false;
  environmentIgnored: true;
  slots: PublicTestnetBootstrapSlot[];
}

export interface PublicTestnetBootstrapAdmission {
  dialTargets: [];
  reasons: string[];
}

export function parsePublicTestnetBootstrap(value: unknown): PublicTestnetBootstrapConfig {
  assertPlainRecord(value, "public-testnet bootstrap");
  assertExactKeys(value, FILE_KEYS, "public-testnet bootstrap");
  if (value.schemaVersion !== 1) throw new Error("Invalid public-testnet bootstrap schema version");
  if (value.networkClass !== "public-testnet") throw new Error("Invalid public-testnet bootstrap network class");
  if (value.live !== false) throw new Error("Public-testnet bootstrap cannot be marked live");
  if (value.environmentIgnored !== true) {
    throw new Error("Public-testnet bootstrap must ignore process environment");
  }
  if (value.status !== "proposal-unfilled" && value.status !== "bootstrap-ready") {
    throw new Error("Invalid public-testnet bootstrap status");
  }
  const status = value.status;
  if (!Array.isArray(value.slots)) throw new Error("Invalid public-testnet bootstrap slots");
  const slots = value.slots.map((entry, index) => parseSlot(entry, status, index));
  if (value.status === "proposal-unfilled" && slots.length !== UNFILLED_SLOTS.length) {
    throw new Error("Unfilled public-testnet bootstrap must contain exactly three placeholder slots");
  }
  assertDistinct(slots);
  if (value.status === "bootstrap-ready") {
    const domains = new Set(slots.map((slot) => slot.failureDomain));
    if (domains.size < PUBLIC_TESTNET_MIN_FAILURE_DOMAINS) {
      throw new Error("Ready public-testnet bootstrap requires at least 3 distinct failure domains");
    }
  }
  return {
    schemaVersion: 1,
    status: value.status,
    networkClass: "public-testnet",
    live: false,
    environmentIgnored: true,
    slots
  };
}

/**
 * Placeholder slots are not dial targets. A structurally complete file still
 * does not dial: `live` is required to stay false, and process environment
 * variables named in the file are never consulted.
 */
export function admitPublicTestnetBootstrap(
  config: PublicTestnetBootstrapConfig,
  publicTestnetActivationAllowed: boolean
): PublicTestnetBootstrapAdmission {
  const reasons: string[] = [];
  if (config.status !== "bootstrap-ready" || config.slots.some(slotIsPlaceholder)) {
    reasons.push("bootstrap-unfilled");
  }
  reasons.push("bootstrap-not-dialable");
  if (publicTestnetActivationAllowed !== true) reasons.push("public-testnet-activation-not-allowed");
  return { dialTargets: [], reasons };
}

function parseSlot(value: unknown, status: "proposal-unfilled" | "bootstrap-ready", index: number): PublicTestnetBootstrapSlot {
  assertPlainRecord(value, "public-testnet bootstrap slot");
  assertExactKeys(value, SLOT_KEYS, "public-testnet bootstrap slot");
  if (typeof value.slot !== "string" || typeof value.failureDomainEnv !== "string" || typeof value.peerIdEnv !== "string" ||
      typeof value.multiaddrEnv !== "string" || typeof value.failureDomain !== "string" || typeof value.peerId !== "string" ||
      typeof value.multiaddr !== "string") {
    throw new Error("Invalid public-testnet bootstrap slot");
  }
  const expected = UNFILLED_SLOTS[index];
  if (status === "proposal-unfilled") {
    if (expected === undefined || value.slot !== expected.slot || value.failureDomainEnv !== expected.failureDomainEnv ||
        value.peerIdEnv !== expected.peerIdEnv || value.multiaddrEnv !== expected.multiaddrEnv) {
      throw new Error("Unfilled public-testnet bootstrap slots must keep the documented placeholder names");
    }
    if (value.failureDomain !== PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER || value.peerId !== PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER ||
        value.multiaddr !== PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER) {
      throw new Error("Unfilled public-testnet bootstrap values must be PLACEHOLDER");
    }
    return placeholderSlot(expected);
  }
  if (value.failureDomain === PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER || value.peerId === PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER ||
      value.multiaddr === PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER) {
    throw new Error("Ready public-testnet bootstrap cannot contain PLACEHOLDER");
  }
  if (!/^bootstrap-[a-z]$/.test(value.slot)) throw new Error("Invalid public-testnet bootstrap slot name");
  if (!/^ZYRON_PUBLIC_TESTNET_BOOTSTRAP_[A-Z]_FAILURE_DOMAIN$/.test(value.failureDomainEnv) ||
      !/^ZYRON_PUBLIC_TESTNET_BOOTSTRAP_[A-Z]_PEER_ID$/.test(value.peerIdEnv) ||
      !/^ZYRON_PUBLIC_TESTNET_BOOTSTRAP_[A-Z]_MULTIADDR$/.test(value.multiaddrEnv)) {
    throw new Error("Invalid public-testnet bootstrap environment variable name");
  }
  const peer = canonicalizePublicTestnetBootstrapPeer(value.peerId, value.multiaddr, value.failureDomain);
  return {
    slot: value.slot,
    failureDomainEnv: value.failureDomainEnv,
    peerIdEnv: value.peerIdEnv,
    multiaddrEnv: value.multiaddrEnv,
    failureDomain: peer.failureDomain,
    peerId: peer.peerId,
    multiaddr: peer.multiaddr
  };
}

function placeholderSlot(expected: (typeof UNFILLED_SLOTS)[number]): PublicTestnetBootstrapSlot {
  return {
    slot: expected.slot,
    failureDomainEnv: expected.failureDomainEnv,
    peerIdEnv: expected.peerIdEnv,
    multiaddrEnv: expected.multiaddrEnv,
    failureDomain: PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER,
    peerId: PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER,
    multiaddr: PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER
  };
}

function slotIsPlaceholder(slot: { failureDomain: string; peerId: string; multiaddr: string }): boolean {
  return slot.failureDomain === PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER ||
    slot.peerId === PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER ||
    slot.multiaddr === PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER;
}

function assertDistinct(slots: readonly PublicTestnetBootstrapSlot[]): void {
  const seen = new Set<string>();
  for (const slot of slots) {
    for (const value of [slot.slot, slot.failureDomainEnv, slot.peerIdEnv, slot.multiaddrEnv, slot.peerId, slot.multiaddr]) {
      if (value === PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER) continue;
      if (seen.has(value)) throw new Error("Duplicate public-testnet bootstrap value");
      seen.add(value);
    }
  }
}

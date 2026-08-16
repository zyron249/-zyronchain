import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createP2PNode } from "./p2p.js";
import { nativePeerId, parseNativePeerAddress } from "./p2p-address.js";
import { loadOrCreateNodeIdentity } from "./peer-identity.js";
import { MAX_STATE_SYNC_PEERS } from "./p2p-state.js";
import { fetchTrustedPortableResumeFromAnyPeer } from "./state-v2-resume-fetch.js";
import { installTrustedPortableResume } from "./state-v2-resume-install.js";
import type { GenesisConfig } from "./types.js";

function values(args: readonly string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected state-fetch-install argument: ${token}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    if (token === name) result.push(value);
    index += 1;
  }
  return result;
}

function requiredSingle(args: readonly string[], name: string): string {
  const found = values(args, name);
  if (found.length !== 1) throw new Error(`state-fetch-install requires exactly one ${name}`);
  return found[0]!;
}

function assertKnownOptions(args: readonly string[]): void {
  const known = new Set(["--genesis", "--p2p-peer", "--data", "--tip-hash", "--sha256"]);
  for (let index = 0; index < args.length; index += 2) {
    const token = args[index];
    if (!token || !known.has(token)) throw new Error(`Unknown state-fetch-install option: ${token ?? "<missing>"}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
  }
}

/** Supported production state-fetch-install path used by secure-cli. */
export async function runStateFetchInstall(args: string[]): Promise<void> {
  assertKnownOptions(args);
  const genesisPath = requiredSingle(args, "--genesis");
  const dataDir = resolve(requiredSingle(args, "--data"));
  const tipHash = requiredSingle(args, "--tip-hash");
  const snapshotSha256 = requiredSingle(args, "--sha256");
  const peerValues = values(args, "--p2p-peer");
  if (peerValues.length < 1 || peerValues.length > MAX_STATE_SYNC_PEERS) {
    throw new Error(`state-fetch-install requires 1-${MAX_STATE_SYNC_PEERS} --p2p-peer values`);
  }
  if (!/^[0-9a-f]{64}$/.test(tipHash) || !/^[0-9a-f]{64}$/.test(snapshotSha256)) {
    throw new Error("state-fetch-install requires lowercase 32-byte --tip-hash and --sha256 anchors");
  }

  const peers = peerValues.map(parseNativePeerAddress);
  if (new Set(peers.map(nativePeerId)).size !== peers.length) throw new Error("state-fetch-install peer IDs must be unique");

  // secure-cli has already descriptor-bound and privately staged --genesis.
  const genesis = JSON.parse(await readFile(resolve(genesisPath), "utf8")) as GenesisConfig;
  const anchor = { tipHash, snapshotSha256 };
  const resumeDir = `${dataDir}.state-sync-${tipHash.slice(0, 16)}-${snapshotSha256.slice(0, 16)}`;
  const identityDir = await mkdtemp(join(tmpdir(), "zyron-state-fetch-"));
  let client: Awaited<ReturnType<typeof createP2PNode>> | undefined;

  try {
    const identity = await loadOrCreateNodeIdentity(identityDir);
    client = await createP2PNode(identity);
    const resume = await fetchTrustedPortableResumeFromAnyPeer(client, peers, identity, genesis, anchor, resumeDir);

    await client.stop();
    client = undefined;

    const installStage = await mkdtemp(join(tmpdir(), "zyron-state-install-"));
    const store = await installTrustedPortableResume(genesis, dataDir, resume, anchor, installStage);
    await rm(resumeDir, { recursive: true, force: true });

    console.log(`Trusted portable State-v2 fetched and installed at height ${store.chain.height}: ${dataDir}`);
    console.log(`Finalized tip: ${store.chain.tip.hash}`);
    console.log(`Snapshot SHA-256: ${snapshotSha256}`);
  } finally {
    if (client) {
      try { await client.stop(); } catch { }
    }
    await rm(identityDir, { recursive: true, force: true });
  }
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  admitPublicTestnetNode,
  parsePublicTestnetIdentity,
  publicTestnetActivationFromAuthorization,
  type FrozenPublicTestnetIdentity,
  type PublicTestnetActivationFlags
} from "../src/public-testnet-identity.js";
import type { GenesisConfig } from "../src/types.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const checkedInIdentityPath = join(here, "../../config/public-testnet-identity.json");
const checkedInBootstrapPath = join(here, "../../config/public-testnet-bootstrap.json");
const checkedInRpcPath = join(here, "../../config/public-testnet-rpc.json");
const launchAuthorizationPath = join(here, "../../../docs/l1-launch-authorization.json");
const cliPath = join(here, "../src/cli.js");

const validatorPublic = publicKeyFromPrivate("01".padStart(64, "0"));
const oraclePublic = publicKeyFromPrivate("02".padStart(64, "0"));
const pool = addressFromPublicKey(publicKeyFromPrivate("03".padStart(64, "0")));
const genesisTimestamp = 1_700_000_000_000;

function peerId(index: number): string {
  return peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from(index.toString(16).padStart(64, "0"), "hex"))).toString();
}

function genesis(chainId: string): GenesisConfig {
  return {
    chainId,
    timestampMs: genesisTimestamp,
    validators: [{ address: addressFromPublicKey(validatorPublic), publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 0 }]
  };
}

function frozenIdentity(chain: GenesisConfig): FrozenPublicTestnetIdentity {
  const ids = [peerId(4), peerId(5), peerId(6)];
  const hosts = ["1.2.3.4", "5.6.7.8", "9.8.7.6"];
  return {
    schemaVersion: 1,
    status: "identity-frozen",
    networkClass: "public-testnet",
    chainId: "zyron-public-testnet-fixture",
    genesisHash: new ZyronChain(chain).genesisHash,
    genesisTimestampMs: chain.timestampMs,
    bootstrapPeers: ids.map((id, index) => {
      const host = hosts[index];
      if (host === undefined) throw new Error("missing bootstrap host");
      return {
        peerId: id,
        multiaddr: `/ip4/${host}/tcp/9140/p2p/${id}`,
        failureDomain: `provider-${index + 1}`
      };
    }),
    publicRpcEndpoints: [
      "https://rpc-a.bootstrap-fixture.net",
      "https://rpc-b.bootstrap-fixture.net"
    ],
    activationAllowed: false,
    publicMiningActivated: false,
    publicationAllowed: false
  };
}

const closedActivation: PublicTestnetActivationFlags = {
  publicTestnetActivationAllowed: false,
  mainnetActivationAllowed: false
};

const forgedOpenActivation: PublicTestnetActivationFlags = {
  publicTestnetActivationAllowed: true,
  mainnetActivationAllowed: false
};

test("checked-in public-testnet proposal stays unfilled and refuses admission", async () => {
  const identity = parsePublicTestnetIdentity(JSON.parse(await readFile(checkedInIdentityPath, "utf8")));
  const authorization = publicTestnetActivationFromAuthorization(JSON.parse(await readFile(launchAuthorizationPath, "utf8")));
  assert.equal(identity.status, "proposal-unfilled");
  assert.equal(identity.chainId, null);
  assert.equal(identity.genesisHash, null);
  assert.equal(authorization.publicTestnetActivationAllowed, false);
  assert.equal(authorization.mainnetActivationAllowed, false);

  const chain = genesis("zyron-public-testnet-fixture");
  const closed = admitPublicTestnetNode({
    identity,
    genesis: chain,
    genesisHash: new ZyronChain(chain).genesisHash,
    activation: authorization
  });
  assert.equal(closed.admitted, false);
  assert.deepEqual(closed.reasons, ["identity-unfilled", "public-testnet-activation-not-allowed"]);

  const forged = admitPublicTestnetNode({
    identity,
    genesis: chain,
    genesisHash: new ZyronChain(chain).genesisHash,
    activation: forgedOpenActivation
  });
  assert.equal(forged.admitted, false);
  assert.deepEqual(forged.reasons, ["identity-unfilled"]);
});

test("identity file cannot grant activation, mining, or publication", () => {
  const chain = genesis("zyron-public-testnet-fixture");
  const identity = frozenIdentity(chain);
  assert.throws(
    () => parsePublicTestnetIdentity({ ...identity, publicMiningActivated: true }),
    /cannot grant publicMiningActivated/
  );
  assert.throws(
    () => parsePublicTestnetIdentity({ ...identity, activationAllowed: true }),
    /cannot grant activationAllowed/
  );
  assert.throws(
    () => parsePublicTestnetIdentity({ ...identity, publicationAllowed: true }),
    /cannot grant publicationAllowed/
  );
});

test("ephemeral and mainnet chain IDs cannot be frozen as the public testnet", () => {
  const chain = genesis("zyron-local-abc");
  const base = frozenIdentity(chain);
  for (const chainId of ["zyron-local-abc", "zyron-devnet-1", "zyron-testnet-1", "zyron-public-testnet-mainnet", "mainnet"]) {
    assert.throws(() => parsePublicTestnetIdentity({ ...base, chainId }), /must not name mainnet|must match zyron-public-testnet/);
  }
});

test("frozen identity admits only when genesis matches and launch authorization allows public testnet", () => {
  const chain = genesis("zyron-public-testnet-fixture");
  const identity = parsePublicTestnetIdentity(frozenIdentity(chain));
  const hash = new ZyronChain(chain).genesisHash;
  assert.equal(admitPublicTestnetNode({
    identity,
    genesis: chain,
    genesisHash: hash,
    activation: forgedOpenActivation
  }).admitted, true);

  const closed = admitPublicTestnetNode({
    identity,
    genesis: chain,
    genesisHash: hash,
    activation: closedActivation
  });
  assert.equal(closed.admitted, false);
  assert.deepEqual(closed.reasons, ["public-testnet-activation-not-allowed"]);

  const mismatched = admitPublicTestnetNode({
    identity,
    genesis: chain,
    genesisHash: "ab".repeat(32),
    activation: forgedOpenActivation
  });
  assert.equal(mismatched.admitted, false);
  assert.deepEqual(mismatched.reasons, ["genesis-hash-mismatch"]);

  const otherChain = genesis("zyron-public-testnet-other");
  const wrongChain = admitPublicTestnetNode({
    identity,
    genesis: otherChain,
    genesisHash: new ZyronChain(otherChain).genesisHash,
    activation: forgedOpenActivation
  });
  assert.equal(wrongChain.admitted, false);
  assert.ok(wrongChain.reasons.includes("chain-id-mismatch"));
  assert.ok(wrongChain.reasons.includes("genesis-hash-mismatch"));
});

test("frozen identity rejects loopback, reserved names, and collapsed failure domains", () => {
  const chain = genesis("zyron-public-testnet-fixture");
  const identity = frozenIdentity(chain);
  const ids = identity.bootstrapPeers.map((peer) => peer.peerId);
  const third = ids[2];
  if (third === undefined) throw new Error("missing third bootstrap peer");
  assert.throws(
    () => parsePublicTestnetIdentity({
      ...identity,
      bootstrapPeers: identity.bootstrapPeers.map((peer) => ({ ...peer, failureDomain: "same-domain" }))
    }),
    /3 distinct failure domains/
  );
  assert.throws(
    () => parsePublicTestnetIdentity({
      ...identity,
      bootstrapPeers: [
        ...identity.bootstrapPeers.slice(0, 2),
        {
          peerId: third,
          multiaddr: `/ip4/127.0.0.1/tcp/9140/p2p/${third}`,
          failureDomain: "provider-3"
        }
      ]
    }),
    /non-public IP/
  );
  assert.throws(
    () => parsePublicTestnetIdentity({
      ...identity,
      bootstrapPeers: [
        ...identity.bootstrapPeers.slice(0, 2),
        {
          peerId: third,
          multiaddr: `/dns4/boot.localhost/tcp/9140/p2p/${third}`,
          failureDomain: "provider-3"
        }
      ]
    }),
    /reserved suffix/
  );
  assert.throws(
    () => parsePublicTestnetIdentity({
      ...identity,
      publicRpcEndpoints: ["https://rpc-a.bootstrap-fixture.net", "http://rpc-b.bootstrap-fixture.net"]
    }),
    /HTTPS/
  );
  assert.throws(
    () => parsePublicTestnetIdentity({
      ...identity,
      publicRpcEndpoints: ["https://127.0.0.1", "https://rpc-b.bootstrap-fixture.net"]
    }),
    /loopback|non-public/
  );
});

test("public-testnet node command fail-closes on the checked-in proposal and refuses mainnet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-public-testnet-identity-"));
  const genesisPath = join(directory, "genesis.json");
  const dataDir = join(directory, "data");
  const chain = genesis("zyron-public-testnet-fixture");
  await writeFile(genesisPath, `${JSON.stringify(chain)}\n`);

  await expectCliFailure([
    "node",
    "--network-class", "public-testnet",
    "--public-testnet-identity", checkedInIdentityPath,
    "--public-testnet-bootstrap", checkedInBootstrapPath,
    "--public-testnet-rpc", checkedInRpcPath,
    "--launch-authorization", launchAuthorizationPath,
    "--genesis", genesisPath,
    "--data", dataDir
  ], /identity-unfilled/);
  await assert.rejects(access(dataDir));

  await expectCliFailure([
    "node",
    "--network-class", "mainnet",
    "--genesis", genesisPath,
    "--data", dataDir
  ], /refusing to invent a mainnet chain identity/);
});

function expectCliFailure(args: string[], pattern: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, ...args], { encoding: "utf8" }, (error, _stdout, stderr) => {
      if (!error) {
        reject(new Error(`expected CLI failure matching ${pattern}`));
        return;
      }
      if (!pattern.test(stderr)) {
        reject(new Error(`stderr did not match ${pattern}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

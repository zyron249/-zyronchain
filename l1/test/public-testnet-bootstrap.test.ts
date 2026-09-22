import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

import {
  admitPublicTestnetBootstrap,
  parsePublicTestnetBootstrap,
  PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER,
  type PublicTestnetBootstrapConfig
} from "../src/public-testnet-bootstrap.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const checkedInPath = join(here, "../../config/public-testnet-bootstrap.json");
const sourcePath = join(here, "../../src/public-testnet-bootstrap.ts");

function peerId(index: number): string {
  return peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from(index.toString(16).padStart(64, "0"), "hex"))).toString();
}

function readyBootstrap(): PublicTestnetBootstrapConfig {
  const ids = [peerId(4), peerId(5), peerId(6)];
  const hosts = ["1.2.3.4", "5.6.7.8", "9.8.7.6"];
  const letters = ["A", "B", "C"] as const;
  return {
    schemaVersion: 1,
    status: "bootstrap-ready",
    networkClass: "public-testnet",
    live: false,
    environmentIgnored: true,
    slots: letters.map((letter, index) => {
      const host = hosts[index];
      const id = ids[index];
      if (host === undefined || id === undefined) throw new Error("missing bootstrap fixture");
      return {
        slot: `bootstrap-${letter.toLowerCase()}`,
        failureDomainEnv: `ZYRON_PUBLIC_TESTNET_BOOTSTRAP_${letter}_FAILURE_DOMAIN`,
        peerIdEnv: `ZYRON_PUBLIC_TESTNET_BOOTSTRAP_${letter}_PEER_ID`,
        multiaddrEnv: `ZYRON_PUBLIC_TESTNET_BOOTSTRAP_${letter}_MULTIADDR`,
        failureDomain: `provider-${index + 1}`,
        peerId: id,
        multiaddr: `/ip4/${host}/tcp/9140/p2p/${id}`
      };
    })
  };
}

test("checked-in bootstrap scaffold is three non-live placeholders and is not dialed", async () => {
  const previous = process.env.ZYRON_PUBLIC_TESTNET_BOOTSTRAP_A_MULTIADDR;
  process.env.ZYRON_PUBLIC_TESTNET_BOOTSTRAP_A_MULTIADDR = "/ip4/1.2.3.4/tcp/9140/p2p/not-a-live-endpoint";
  try {
    const config = parsePublicTestnetBootstrap(JSON.parse(await readFile(checkedInPath, "utf8")));
    assert.equal(config.status, "proposal-unfilled");
    assert.equal(config.live, false);
    assert.equal(config.environmentIgnored, true);
    assert.equal(config.slots.length, 3);
    assert.deepEqual(config.slots.map((slot) => slot.failureDomain), [
      PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER,
      PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER,
      PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER
    ]);
    const domains = new Set(config.slots.map((slot) => slot.failureDomain).filter((domain) => domain !== PUBLIC_TESTNET_BOOTSTRAP_PLACEHOLDER));
    assert.equal(domains.size, 0);
    const admission = admitPublicTestnetBootstrap(config, true);
    assert.deepEqual(admission.dialTargets, []);
    assert.deepEqual(admission.reasons, ["bootstrap-unfilled", "bootstrap-not-dialable"]);
    assert.equal(JSON.stringify(config).includes("/ip4/1.2.3.4"), false);
  } finally {
    if (previous === undefined) delete process.env.ZYRON_PUBLIC_TESTNET_BOOTSTRAP_A_MULTIADDR;
    else process.env.ZYRON_PUBLIC_TESTNET_BOOTSTRAP_A_MULTIADDR = previous;
  }
});

test("bootstrap parser does not consult process environment", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.equal(source.includes("process.env"), false);
});

test("placeholder file cannot be promoted by marking it live or inventing one domain", () => {
  const config = {
    schemaVersion: 1,
    status: "proposal-unfilled",
    networkClass: "public-testnet",
    live: false,
    environmentIgnored: true,
    slots: []
  };
  assert.throws(() => parsePublicTestnetBootstrap({ ...config, live: true }), /cannot be marked live/);
  assert.throws(() => parsePublicTestnetBootstrap({ ...config, environmentIgnored: false }), /ignore process environment/);
  assert.throws(() => parsePublicTestnetBootstrap(config), /exactly three placeholder slots/);
});

test("a structurally complete bootstrap still has no dial targets", () => {
  const config = parsePublicTestnetBootstrap(readyBootstrap());
  assert.equal(config.slots.length, 3);
  assert.equal(new Set(config.slots.map((slot) => slot.failureDomain)).size, 3);
  const closed = admitPublicTestnetBootstrap(config, false);
  assert.deepEqual(closed.dialTargets, []);
  assert.ok(closed.reasons.includes("bootstrap-not-dialable"));
  assert.ok(closed.reasons.includes("public-testnet-activation-not-allowed"));
  const forged = admitPublicTestnetBootstrap(config, true);
  assert.deepEqual(forged.dialTargets, []);
  assert.deepEqual(forged.reasons, ["bootstrap-not-dialable"]);
});

test("ready bootstrap rejects loopback endpoints and collapsed failure domains", () => {
  const config = readyBootstrap();
  const third = config.slots[2];
  if (third === undefined) throw new Error("missing third slot");
  assert.throws(
    () => parsePublicTestnetBootstrap({
      ...config,
      slots: config.slots.map((slot) => ({ ...slot, failureDomain: "same-domain" }))
    }),
    /3 distinct failure domains|Duplicate/
  );
  assert.throws(
    () => parsePublicTestnetBootstrap({
      ...config,
      slots: [
        ...config.slots.slice(0, 2),
        { ...third, multiaddr: `/ip4/127.0.0.1/tcp/9140/p2p/${third.peerId}` }
      ]
    }),
    /non-public IP/
  );
});

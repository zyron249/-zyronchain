import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  addressFromPublicKey,
  publicKeyFromPrivate,
  signCanonical,
  signCanonicalDomain,
  verifyCanonicalDomain
} from "../src/crypto.js";
import { NodeService, produceFinalizedBlock, type ConsensusPeerClient } from "../src/node.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import type { GenesisConfig } from "../src/types.js";
import { RemoteValidatorSigner } from "../src/validator-signer.js";

const validatorOnePrivate = "01".padStart(64, "0");
const validatorTwoPrivate = "02".padStart(64, "0");
const oraclePrivate = "04".padStart(64, "0");
const activityPrivate = "06".padStart(64, "0");
const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const oraclePublic = publicKeyFromPrivate(oraclePrivate);
const activityPool = addressFromPublicKey(publicKeyFromPrivate(activityPrivate));
const testToken = "remote-signer-integration-token-".padEnd(64, "x");

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-devnet-1",
    timestampMs: 1_700_000_000_000,
    validators: [
      { address: addressFromPublicKey(validatorOnePublic), publicKey: validatorOnePublic },
      { address: addressFromPublicKey(validatorTwoPublic), publicKey: validatorTwoPublic }
    ],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 5_000_000_000 }]
  };
}

test("authenticated remote validator signer keeps the secret out of the node and signs proposals plus attestations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-remote-signer-auth-integration-"));
  const intents: string[] = [];
  const authorizations: Array<string | undefined> = [];
  const signerServer = createServer(async (request, response) => {
    authorizations.push(request.headers.authorization);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { intent: string; payload: unknown };
    intents.push(body.intent);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ signature: signCanonical(body.payload, validatorOnePrivate) }));
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      signerServer.once("error", reject);
      signerServer.listen(0, "127.0.0.1", resolveListen);
    });
    const address = signerServer.address();
    if (!address || typeof address === "string") throw new Error("Signer test server has no TCP address");
    const signer = new RemoteValidatorSigner(
      `http://127.0.0.1:${address.port}/sign`,
      validatorOnePublic,
      testToken
    );
    const store = await ChainStore.open(genesis(), directory);
    const journal = await SigningJournal.open(directory);
    const service = new NodeService(store, journal, signer);
    const peers: ConsensusPeerClient = {
      requestAttestations: async (block) => [store.chain.attestBlock(block, validatorTwoPrivate).attestations[0]!],
      requestRoundSkips: async () => [],
      broadcastBlock: async () => undefined
    };
    const block = await produceFinalizedBlock(service, peers, signer, genesis().timestampMs + 30_000);
    assert.ok(block);
    assert.equal(block.header.height, 1);
    assert.deepEqual(intents, ["block-proposal", "block-attestation"]);
    assert.deepEqual(authorizations, [`Bearer ${testToken}`, `Bearer ${testToken}`]);
    assert.equal(service.status().height, 1);
    journal.close();
  } finally {
    if (signerServer.listening) {
      await new Promise<void>((resolveClose, reject) =>
        signerServer.close((error) => error ? reject(error) : resolveClose())
      );
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("authenticated remote validator signer is fail-closed on wrong-key signatures and unsafe plaintext endpoints", async () => {
  assert.throws(
    () => new RemoteValidatorSigner("http://192.0.2.10/sign", validatorOnePublic, testToken),
    /loopback/
  );
  const signerServer = createServer(async (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ signature: signCanonical({ height: 1 }, validatorTwoPrivate) }));
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      signerServer.once("error", reject);
      signerServer.listen(0, "127.0.0.1", resolveListen);
    });
    const address = signerServer.address();
    if (!address || typeof address === "string") throw new Error("Signer test server has no TCP address");
    const signer = new RemoteValidatorSigner(
      `http://127.0.0.1:${address.port}/sign`,
      validatorOnePublic,
      testToken
    );
    await assert.rejects(
      () => signer.signCanonical({ height: 1 }, "block-proposal"),
      /wrong key or payload/
    );
  } finally {
    if (signerServer.listening) {
      await new Promise<void>((resolveClose, reject) =>
        signerServer.close((error) => error ? reject(error) : resolveClose())
      );
    }
  }
});

test("authenticated remote validator signer binds protocol v3 requests and responses to the exact signing domain", async () => {
  const requests: Array<{ version: number; intent: string; domain?: string; authorization?: string }> = [];
  const signerServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      version: number;
      intent: string;
      domain?: string;
      payload: unknown;
    };
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string") {
      throw new Error("Authenticated remote signer request is missing the Authorization header");
    }
    requests.push({
      version: body.version,
      intent: body.intent,
      ...(body.domain === undefined ? {} : { domain: body.domain }),
      authorization
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      signature: signCanonicalDomain(body.domain!, body.payload, validatorOnePrivate)
    }));
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      signerServer.once("error", reject);
      signerServer.listen(0, "127.0.0.1", resolveListen);
    });
    const address = signerServer.address();
    if (!address || typeof address === "string") throw new Error("Signer test server has no TCP address");
    const signer = new RemoteValidatorSigner(
      `http://127.0.0.1:${address.port}/sign`,
      validatorOnePublic,
      testToken
    );
    const payload = { chainId: genesis().chainId, height: 9, blockHash: "a".repeat(64) };
    const signature = await signer.signCanonical(payload, "block-attestation", 3);

    assert.equal(
      verifyCanonicalDomain("zyronchain/finality-attestation/v1", payload, signature, validatorOnePublic),
      true
    );
    assert.deepEqual(requests, [{
      version: 2,
      intent: "block-attestation",
      domain: "zyronchain/finality-attestation/v1",
      authorization: `Bearer ${testToken}`
    }]);
  } finally {
    if (signerServer.listening) {
      await new Promise<void>((resolveClose, reject) =>
        signerServer.close((error) => error ? reject(error) : resolveClose())
      );
    }
  }
});

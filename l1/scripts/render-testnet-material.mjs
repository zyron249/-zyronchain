import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ZyronChain } from "../dist/src/chain.js";
import { readBoundedRegularControlFile } from "../dist/src/control-file.js";
import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import { readPrivateRegularFile } from "../dist/src/local-security.js";

const VALIDATOR_COUNT = 4;
const TEST_ALLOCATION_ATOMS = 100_000_000;
const MAX_RENDER_GENESIS_BYTES = 64 * 1024;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseValidatorKey(value, index, keyPath, dataDir, rpcBasePort) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `validator-${index + 1} key must be an object`);
  const keys = Object.keys(value).sort();
  assert.deepEqual(keys, ["address", "privateKey", "publicKey"], `validator-${index + 1} key has unexpected fields`);
  assert.equal(typeof value.privateKey, "string");
  assert.equal(typeof value.publicKey, "string");
  assert.equal(typeof value.address, "string");
  const publicKey = publicKeyFromPrivate(value.privateKey);
  assert.equal(publicKey, value.publicKey, `validator-${index + 1} public key mismatch`);
  assert.equal(addressFromPublicKey(publicKey), value.address, `validator-${index + 1} address mismatch`);
  return {
    index,
    privateKey: value.privateKey,
    publicKey,
    address: value.address,
    rpcPort: rpcBasePort + index,
    keyPath,
    dataDir
  };
}

export async function loadOrCreateRenderTestnetMaterial(root, chainId, rpcBasePort) {
  const genesisPath = join(root, "genesis.json");
  const keyPaths = Array.from({ length: VALIDATOR_COUNT }, (_, index) => join(root, `validator-${index + 1}.json`));
  const dataDirs = Array.from({ length: VALIDATOR_COUNT }, (_, index) => join(root, `validator-${index + 1}-data`));
  const genesisExists = await exists(genesisPath);
  const keyExistence = await Promise.all(keyPaths.map(exists));

  if (genesisExists) {
    assert.ok(keyExistence.every(Boolean), "Existing Render testnet root is missing one or more validator key files");
    const validators = [];
    for (let index = 0; index < VALIDATOR_COUNT; index += 1) {
      const text = await readPrivateRegularFile(keyPaths[index], `validator-${index + 1} key`);
      const value = JSON.parse(text);
      validators.push(parseValidatorKey(value, index, keyPaths[index], dataDirs[index], rpcBasePort));
    }
    const genesis = JSON.parse(await readBoundedRegularControlFile(
      genesisPath,
      "Existing Render genesis",
      MAX_RENDER_GENESIS_BYTES
    ));
    assert.equal(genesis.chainId, chainId, "Existing Render testnet root has a different chain ID");
    assert.ok(Array.isArray(genesis.validators) && genesis.validators.length === VALIDATOR_COUNT, "Existing Render genesis validator count mismatch");
    for (let index = 0; index < VALIDATOR_COUNT; index += 1) {
      assert.equal(genesis.validators[index]?.publicKey, validators[index].publicKey, `Genesis validator-${index + 1} public key mismatch`);
      assert.equal(genesis.validators[index]?.address, validators[index].address, `Genesis validator-${index + 1} address mismatch`);
    }
    const validatedGenesis = new ZyronChain(genesis);
    return { genesis, genesisPath, validators, validatedGenesis, reused: true };
  }

  assert.ok(keyExistence.every((present) => !present), "Render testnet root contains validator keys without genesis; refusing partial recovery state");

  const validators = [];
  for (let index = 0; index < VALIDATOR_COUNT; index += 1) {
    const privateKey = generatePrivateKey();
    const publicKey = publicKeyFromPrivate(privateKey);
    validators.push({
      index,
      privateKey,
      publicKey,
      address: addressFromPublicKey(publicKey),
      rpcPort: rpcBasePort + index,
      keyPath: keyPaths[index],
      dataDir: dataDirs[index]
    });
  }

  const oraclePublicKey = publicKeyFromPrivate(generatePrivateKey());
  const activityPool = addressFromPublicKey(publicKeyFromPrivate(generatePrivateKey()));
  const genesis = {
    chainId,
    timestampMs: Date.now() - 60_000,
    validators: validators.map(({ publicKey, address }) => ({ publicKey, address })),
    activityOracles: [oraclePublicKey],
    activityPool,
    allocations: [
      ...validators.map(({ address }) => ({ address, amountAtoms: TEST_ALLOCATION_ATOMS })),
      { address: activityPool, amountAtoms: TEST_ALLOCATION_ATOMS }
    ]
  };
  const validatedGenesis = new ZyronChain(genesis);

  await writeFile(genesisPath, `${JSON.stringify(genesis, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  for (const validator of validators) {
    await writeFile(validator.keyPath, `${JSON.stringify({
      privateKey: validator.privateKey,
      publicKey: validator.publicKey,
      address: validator.address
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }

  return { genesis, genesisPath, validators, validatedGenesis, reused: false };
}

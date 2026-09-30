import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { decryptPrivateKey } from "../src/keystore.js";
import { toChecksumAddress as toChecksum } from "../src/address-checksum.js";
import { validateTransactionShape } from "../src/transaction.js";
import type { Address, GenesisConfig, Transaction } from "../src/types.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PASSWORD = "a-strong-local-wallet-password";

async function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024
  });
}

async function wallet(root: string): Promise<{ keyPath: string; passwordPath: string; address: Address; privateKey: string }> {
  const keyPath = join(root, "wallet.json");
  const passwordPath = join(root, "wallet.password");
  await writeFile(passwordPath, `${PASSWORD}\n`, { mode: 0o600 });
  await cli(["keygen", "--out", keyPath, "--password-file", passwordPath]);
  const record = JSON.parse(await readFile(keyPath, "utf8")) as { address: Address };
  return { keyPath, passwordPath, address: record.address, privateKey: decryptPrivateKey(record, PASSWORD) };
}

const receiver = addressFromPublicKey(publicKeyFromPrivate("62".padStart(64, "0")));

test("keystore-verify decrypts locally and prints only public identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-keystore-verify-"));
  try {
    const w = await wallet(root);
    const { stdout, stderr } = await cli(["keystore-verify", "--key", w.keyPath], { ZYRON_KEYSTORE_PASSWORD_FILE: w.passwordPath });
    assert.match(stdout, /Keystore verified/);
    assert.match(stdout, new RegExp(`Address: ${w.address}`));
    assert.doesNotMatch(stdout + stderr, new RegExp(w.privateKey));

    const wrong = join(root, "wrong.password");
    await writeFile(wrong, "definitely-not-the-password\n", { mode: 0o600 });
    await assert.rejects(
      cli(["keystore-verify", "--key", w.keyPath], { ZYRON_KEYSTORE_PASSWORD_FILE: wrong }),
      /authentication failed/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transfer-sign produces a consensus-valid transfer offline and tx-submit broadcasts it unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-offline-sign-"));
  let submitted: Record<string, unknown> | undefined;
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      submitted = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const body = JSON.stringify({ txid: submitted.txid });
      response.writeHead(202, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-zyron-rpc-version": "1" });
      response.end(body);
    });
  });
  try {
    const w = await wallet(root);
    const env = { ZYRON_KEYSTORE_PASSWORD_FILE: w.passwordPath };
    const chainId = "zyron-offline-sign-test";
    const out = join(root, "tx.json");
    const { stdout } = await cli([
      "transfer-sign", "--key", w.keyPath, "--chain-id", chainId, "--to", receiver,
      "--amount-atoms", "150000000", "--fee-atoms", "1000", "--nonce", "1", "--tx-version", "1", "--out", out
    ], env);
    assert.match(stdout, /Transaction ID: [0-9a-f]{64}/);
    const text = await readFile(out, "utf8");
    assert.doesNotMatch(text, new RegExp(w.privateKey), "signed file contains no secret");
    const tx = JSON.parse(text) as Transaction;
    validateTransactionShape(tx);
    assert.equal(tx.kind, "transfer");
    assert.equal(tx.sender, w.address);

    // The offline-signed transfer is accepted by consensus admission on a chain that funds the sender.
    const validatorPrivate = "63".padStart(64, "0");
    const validatorPublic = publicKeyFromPrivate(validatorPrivate);
    const poolAddress = addressFromPublicKey(publicKeyFromPrivate("64".padStart(64, "0")));
    const genesis: GenesisConfig = {
      chainId,
      timestampMs: 1_700_000_000_000,
      validators: [{ address: addressFromPublicKey(validatorPublic), publicKey: validatorPublic }],
      activityOracles: [publicKeyFromPrivate("65".padStart(64, "0"))],
      activityPool: poolAddress,
      allocations: [{ address: poolAddress, amountAtoms: 0 }, { address: w.address, amountAtoms: 1_000_000_000 }]
    };
    const chain = new ZyronChain(genesis);
    assert.doesNotThrow(() => chain.validateMempoolAdmission(tx));

    // A different chain ID must not accept it (replay protection is in the signed payload).
    const other = new ZyronChain({ ...genesis, chainId: "zyron-other-chain" });
    assert.throws(() => other.validateMempoolAdmission(tx));

    // Version 2 (protocol >= 3) signing also produces a valid transfer.
    const outV2 = join(root, "tx-v2.json");
    await cli([
      "transfer-sign", "--key", w.keyPath, "--chain-id", chainId, "--to", receiver,
      "--amount-atoms", "1", "--nonce", "2", "--tx-version", "2", "--out", outV2
    ], env);
    const txV2 = JSON.parse(await readFile(outV2, "utf8")) as Transaction;
    validateTransactionShape(txV2);
    assert.equal(txV2.version, 2);

    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const rpc = `http://127.0.0.1:${port}`;

    // Tampered file is rejected locally before any network request.
    const tampered = join(root, "tampered.json");
    await writeFile(tampered, JSON.stringify({ ...tx, amountAtoms: tx.kind === "transfer" ? tx.amountAtoms + 1 : 0 }));
    await assert.rejects(cli(["tx-submit", "--tx", tampered, "--rpc", rpc]), /Transaction ID mismatch|Invalid transaction signature/);
    assert.equal(requests, 0);

    const submittedOut = await cli(["tx-submit", "--tx", out, "--rpc", rpc]);
    assert.match(submittedOut.stdout, new RegExp(`Submitted transaction ${tx.txid}`));
    assert.deepEqual(submitted, tx);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("transfer-sign requires explicit nonce, tx-version and a valid receiver; never overwrites", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-offline-sign-args-"));
  try {
    const w = await wallet(root);
    const env = { ZYRON_KEYSTORE_PASSWORD_FILE: w.passwordPath };
    const base = ["transfer-sign", "--key", w.keyPath, "--chain-id", "zyron-devnet-1", "--amount-atoms", "5"];
    const out = join(root, "tx.json");
    await assert.rejects(cli([...base, "--to", receiver, "--tx-version", "1", "--out", out], env), /--nonce/);
    await assert.rejects(cli([...base, "--to", receiver, "--nonce", "1", "--out", out], env), /--tx-version/);
    await assert.rejects(cli([...base, "--to", receiver, "--nonce", "0", "--tx-version", "1", "--out", out], env), /next account nonce/);
    await assert.rejects(cli([...base, "--to", receiver, "--nonce", "1", "--tx-version", "3", "--out", out], env), /tx-version must be 1 or 2/);
    await assert.rejects(cli([...base, "--to", "ZYNnot-an-address", "--nonce", "1", "--tx-version", "1", "--out", out], env));
    await assert.rejects(cli([...base, "--to", w.address, "--nonce", "1", "--tx-version", "1", "--out", out], env), /differ from the sender/);
    await cli([...base, "--to", receiver, "--nonce", "1", "--tx-version", "1", "--out", out], env);
    await assert.rejects(cli([...base, "--to", receiver, "--nonce", "1", "--tx-version", "1", "--out", out], env), /EEXIST/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keystore-migrate upgrades v1 to v2 without overwriting; ZYRON_KEYSTORE_PASSWORD env works; address-checksum and checksummed --to", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-keystore-migrate-"));
  try {
    const legacy = {
      version: 1, kdf: "scrypt", cipher: "aes-256-gcm",
      salt: "59892c3f19041bcfdb5d5886832a0f29b251a0248bce7c0c6b9d2bb9c5cd74a6",
      iv: "c26057b446e0fe605094f884", tag: "ad3869d3cb2ea3aa68b648d9362ac038",
      ciphertext: "6eacfe3883bb825d7616beac6b3018b6b9dc8e6e96247b26e5ba90c1b43a4d72fccd9c72595bf82b73bf994acb180c332bdaa62de5da756271e47340783b409d",
      publicKey: "a598a8030da6d86c6bc7f2f5144ea549d28211ea58faa70ebf4c1e665c1fe9b5204b5d6f84822c307e4b4a7140737aec23fc63b65b35f86a10026dbd2d864e6b",
      address: "ZYN80636eaa7a0a54ad4e369e0b6c6f08ead6a49448"
    };
    const oldPath = join(root, "old.json");
    const newPath = join(root, "new.json");
    await writeFile(oldPath, JSON.stringify(legacy), { mode: 0o600 });
    const env = { ZYRON_KEYSTORE_PASSWORD: "legacy v1 keystore password" };
    const verifyOld = await cli(["keystore-verify", "--key", oldPath], env);
    assert.match(verifyOld.stdout, /Keystore format: v1 \(legacy/);
    assert.match(verifyOld.stderr, /ZYRON_KEYSTORE_PASSWORD from the environment/);
    const migrated = await cli(["keystore-migrate", "--key", oldPath, "--out", newPath], env);
    assert.match(migrated.stdout, /migrated v1 -> v2/);
    const parsed = JSON.parse(await readFile(newPath, "utf8")) as Record<string, unknown>;
    assert.equal(parsed.version, 2);
    assert.equal(parsed.address, legacy.address);
    assert.equal(JSON.parse(await readFile(oldPath, "utf8")).version, 1, "original kept");
    const verifyNew = await cli(["keystore-verify", "--key", newPath], env);
    assert.match(verifyNew.stdout, /Keystore format: v2 \(scrypt N=2\^17/);
    assert.match(verifyNew.stdout, /checksummed display\): ZYN80636Eaa7A0A54ad4E369E0b6C6F08eAd6a49448/);
    await assert.rejects(cli(["keystore-migrate", "--key", oldPath, "--out", newPath], env), /EEXIST/);
    await assert.rejects(cli(["keystore-migrate", "--key", oldPath, "--out", join(root, "x.json")], { ZYRON_KEYSTORE_PASSWORD: "wrong wrong wrong" }), /authentication failed/);

    const shown = await cli(["address-checksum", "--address", "ZYN80636Eaa7A0A54ad4E369E0b6C6F08eAd6a49448"]);
    assert.match(shown.stdout, /Canonical \(consensus\) address: ZYN80636eaa7a0a54ad4e369e0b6c6f08ead6a49448/);
    assert.match(shown.stdout, /Checksum: verified/);
    await assert.rejects(cli(["address-checksum", "--address", "ZYN80636eAa7A0A54ad4E369E0b6C6F08eAd6a49448"]), /checksum mismatch/);

    // transfer-sign accepts the checksummed receiver and signs the canonical lower-case address.
    const out = join(root, "tx.json");
    await cli([
      "transfer-sign", "--key", newPath, "--chain-id", "zyron-devnet-1", "--to", toChecksum(receiver),
      "--amount-atoms", "5", "--nonce", "1", "--tx-version", "1", "--out", out
    ], env);
    assert.equal((JSON.parse(await readFile(out, "utf8")) as { receiver: string }).receiver, receiver);
    // Without a password source and without a TTY, the CLI refuses instead of hanging.
    await assert.rejects(cli(["keystore-verify", "--key", newPath], { ZYRON_KEYSTORE_PASSWORD: "" }), /No interactive terminal/);
    await assert.rejects(cli(["keygen", "--out", join(root, "k.json"), "--password-prompt"]), /No interactive terminal/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

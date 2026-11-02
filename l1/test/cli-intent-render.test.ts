import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { toChecksumAddress } from "../src/address-checksum.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { validateTransactionShape } from "../src/transaction.js";
import type { Address, Transaction } from "../src/types.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PASSWORD = "a-strong-local-wallet-password";
const receiver = addressFromPublicKey(publicKeyFromPrivate("62".padStart(64, "0")));
const otherReceiver = addressFromPublicKey(publicKeyFromPrivate("66".padStart(64, "0")));
const LABELS = ["Kind", "Version", "Chain ID", "From", "To", "Amount", "Fee", "Total", "Nonce", "Timestamp", "Public key", "Domain"];

async function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 });
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zyron-6a-cli-"));
  const keyPath = join(root, "wallet.json");
  const passwordPath = join(root, "wallet.password");
  await writeFile(passwordPath, `${PASSWORD}\n`, { mode: 0o600 });
  await cli(["keygen", "--out", keyPath, "--password-file", passwordPath]);
  const address = (JSON.parse(await readFile(keyPath, "utf8")) as { address: Address }).address;
  const env = { ZYRON_KEYSTORE_PASSWORD_FILE: passwordPath };
  const base = ["transfer-sign", "--key", keyPath, "--chain-id", "zyron-devnet-1", "--to", receiver, "--amount-atoms", "150000000", "--fee-atoms", "100000", "--nonce", "1", "--timestamp-ms", "1761408000000"];
  return { root, address, env, base };
}

test("6A CLI: transfer-sign refuses without confirmation and no TTY, after printing the full render", async () => {
  const { root, env, base } = await setup();
  try {
    const out = join(root, "tx.json");
    await assert.rejects(cli([...base, "--out", out], env), (error: { stderr: string }) => {
      for (const label of LABELS) assert.match(error.stderr, new RegExp(`^${label}: `, "m"), label);
      assert.match(error.stderr, /no interactive terminal to confirm/);
      return true;
    });
    assert.equal(await exists(out), false, "nothing was signed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("6A CLI: --yes cannot be enabled by environment variables", async () => {
  const { root, env, base } = await setup();
  try {
    const out = join(root, "tx.json");
    const sneaky = { ...env, ZYRON_YES: "1", ZYRON_CLI_YES: "1", ZYRON_TRANSFER_YES: "1", ZYRON_ASSUME_YES: "1", YES: "1", CI: "1", npm_config_yes: "true" };
    await assert.rejects(cli([...base, "--out", out], sneaky), /no interactive terminal to confirm/);
    assert.equal(await exists(out), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("6A CLI: --yes still prints the full render to stderr and signs a version-2 transfer by default", async () => {
  const { root, env, base, address } = await setup();
  try {
    const out = join(root, "tx.json");
    const { stdout, stderr } = await cli([...base, "--yes", "--out", out], env);
    for (const label of LABELS) assert.match(stderr, new RegExp(`^${label}: `, "m"), label);
    assert.match(stderr, /^Amount: 1\.5 ZYN \(150000000 atoms\)$/m);
    assert.match(stderr, /^Total: 1\.501 ZYN \(150100000 atoms\)$/m);
    assert.match(stderr, new RegExp(`^To: ${toChecksumAddress(receiver)}$`, "m"));
    assert.match(stderr, /^Timestamp: 1761408000000 ms \(2025-10-25T16:00:00\.000Z\)$/m);
    assert.match(stderr, /Confirmed by --yes/);
    assert.doesNotMatch(stdout, /^Kind: /m, "the render goes to stderr");
    const tx = JSON.parse(await readFile(out, "utf8")) as Transaction;
    validateTransactionShape(tx);
    assert.equal(tx.version, 2);
    assert.equal(tx.sender, address);
    await assert.rejects(cli([...base, "--yes", "--yes", "--out", join(root, "b.json")], env), /--yes may only be supplied once/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("6A CLI: --expect-receiver and --expect-amount fail closed", async () => {
  const { root, env, base } = await setup();
  try {
    const out = join(root, "tx.json");
    await assert.rejects(cli([...base, "--yes", "--expect-receiver", otherReceiver, "--out", out], env), /receiver does not match --expect-receiver/);
    await assert.rejects(cli([...base, "--yes", "--expect-amount", "150000001", "--out", out], env), /amount does not match --expect-amount/);
    await assert.rejects(cli([...base, "--yes", "--expect-amount", "1.5", "--out", out], env), /--expect-amount must be a whole number/);
    await assert.rejects(cli([...base, "--yes", "--expect-receiver", "ZYNbad", "--out", out], env), /--expect-receiver is not a valid address/);
    assert.equal(await exists(out), false);
    await cli([...base, "--yes", "--expect-receiver", toChecksumAddress(receiver), "--expect-amount", "150000000", "--out", out], env);
    assert.equal(await exists(out), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("6A CLI: transfer-sign refuses a tx-version that disagrees with the chain protocol, and non-testnet chain IDs", async () => {
  const { root, env, base } = await setup();
  try {
    const out = join(root, "tx.json");
    await assert.rejects(cli([...base, "--yes", "--tx-version", "1", "--out", out], env), /tx-version 1 is refused.*cannot be overridden/);
    const mainnet = base.map((arg) => (arg === "zyron-devnet-1" ? "zyron-mainnet-1" : arg));
    await assert.rejects(cli([...mainnet, "--yes", "--out", out], env), /not in the fixed list of renderable testnet or devnet chain IDs/);
    assert.equal(await exists(out), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

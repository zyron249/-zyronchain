// P1-07 tooling: CLI support for validator possession proofs
// (docs/VALIDATOR_POSSESSION_PROOF.md, docs/VALIDATOR_ONBOARDING.md §4).
//   - `validator-possession-proof` signs a proof with the operator's own key,
//     either for a genesis validator (`--genesis`, activation height 0, chain
//     binding = proof-independent genesis configuration commitment) or for a
//     validator that a `validator_update` brings in (`--proposal` plus
//     `--genesis-hash`, activation height of the proposal).
//   - `validator-submit --possession-proof <file>` (repeatable) attaches
//     `possessionProofs` in proposal validator order, after verifying every
//     proof against the chain's genesis hash from RPC; without the option the
//     transaction is unchanged (no field).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { RPC_API_VERSION } from "../src/node-base.js";
import { defaultPublicDistributionRelease } from "../src/public-distribution-release.js";
import { createValidatorApproval, validateTransactionShape } from "../src/transaction.js";
import { ATOMS_PER_ZYN, type GenesisConfig, type ValidatorSetUpdateTx } from "../src/types.js";
import {
  POSSESSION_PROOF_POLICY_V1,
  assertGenesisPossessionProofs,
  verifyPossessionProof
} from "../src/validator-admission.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const secureCli = fileURLToPath(new URL("../src/secure-cli.js", import.meta.url));

const ZYN = ATOMS_PER_ZYN;
const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATORS = [0x21, 0x22, 0x23, 0x24];
const CHAIN_ID = "cli-possession-proof";
const GENESIS_HASH = "ab".repeat(32);
const OTHER_GENESIS_HASH = "cd".repeat(32);

function strictGenesis(): GenesisConfig {
  const founder = addr(0x13);
  const distributed = addr(0x14);
  const liquidity = addr(0x15);
  const ecosystem = addr(0x16);
  return {
    chainId: CHAIN_ID,
    timestampMs: 1_700_000_000_000,
    networkClass: "public-launch",
    validators: VALIDATORS.map((id) => ({ address: addr(id), publicKey: pub(id) })),
    activityOracles: [pub(0x12), pub(0x17), pub(0x18)],
    activityOracleThreshold: 2,
    activityOraclePolicy: "threshold-v1",
    activityPool: ecosystem,
    allocations: [
      { address: founder, amountAtoms: 5_000_000 * ZYN },
      { address: distributed, amountAtoms: 20_000_000 * ZYN },
      { address: liquidity, amountAtoms: 20_000_000 * ZYN },
      { address: ecosystem, amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: founder, permanentLiquidity: liquidity },
    launchProfile: "fixed-supply-v1",
    publicDistributionRelease: defaultPublicDistributionRelease(distributed)
  } as GenesisConfig;
}

async function run(args: string[], entry = cli) {
  try {
    const result = await execFileAsync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 20_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeKey(dir: string, n: number): Promise<string> {
  const path = join(dir, `k${n}.json`);
  await writeFile(path, JSON.stringify({ privateKey: key(n) }), { mode: 0o600 });
  return path;
}

// Sender 0x21 (a current validator) proposes adding 0x31 and 0x32 to the set.
const INCOMING = [0x31, 0x32];
const ACTIVATION = 200;
function proposal() {
  return {
    transactionVersion: 1,
    chainId: CHAIN_ID,
    nonce: 1,
    sender: addr(0x21),
    activationHeight: ACTIVATION,
    validators: [...VALIDATORS, ...INCOMING].map((id) => ({ address: addr(id), publicKey: pub(id) }))
  };
}

async function writeProposalAndApprovals(dir: string): Promise<{ proposalPath: string; approvals: string[] }> {
  const value = proposal();
  const proposalPath = join(dir, "proposal.json");
  await writeFile(proposalPath, `${JSON.stringify(value, null, 2)}\n`);
  const approvals: string[] = [];
  for (const id of VALIDATORS.slice(0, 3)) {
    const approval = createValidatorApproval(value, key(id), pub(id), 1);
    const path = join(dir, `approval-${id}.json`);
    await writeFile(path, `${JSON.stringify(approval, null, 2)}\n`);
    approvals.push(path);
  }
  return { proposalPath, approvals };
}

async function startMockRpc(): Promise<{ server: Server; url: string; posted: unknown[] }> {
  const posted: unknown[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const reply = (status: number, body?: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "x-zyron-rpc-version": String(RPC_API_VERSION) });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (request.method === "POST" && path === "/tx") {
      let text = "";
      request.on("data", (chunk) => { text += chunk; });
      request.on("end", () => {
        const tx = JSON.parse(text) as { txid: string };
        posted.push(tx);
        reply(200, { txid: tx.txid });
      });
      return;
    }
    if (path === "/status") reply(200, { chainId: CHAIN_ID, genesisHash: GENESIS_HASH, height: 10, tipHash: "ef".repeat(32) });
    else if (path.startsWith("/nonce/")) reply(200, { nonce: 0 });
    else if (path === "/protocol") reply(200, { currentVersion: 1, nextVersion: 1 });
    else reply(404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}`, posted };
}

async function makeUpdateProof(dir: string, id: number, genesisHash = GENESIS_HASH, proposalPath?: string): Promise<string> {
  const out = join(dir, `update-proof-${id}-${genesisHash.slice(0, 4)}.json`);
  const result = await run([
    "validator-possession-proof",
    "--proposal", proposalPath ?? join(dir, "proposal.json"),
    "--genesis-hash", genesisHash,
    "--key", await writeKey(dir, id),
    "--out", out
  ]);
  assert.equal(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
  return out;
}

test("validator-possession-proof --genesis: each operator signs locally; assembled proofs pass the genesis check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-pop-genesis-"));
  try {
    const genesis = strictGenesis();
    const genesisPath = join(dir, "genesis.json");
    await writeFile(genesisPath, `${JSON.stringify(genesis, null, 2)}\n`);
    const proofs: unknown[] = [];
    // Sign in reverse order: the proof file does not depend on signing order.
    for (const id of [...VALIDATORS].reverse()) {
      const out = join(dir, `proof-${id}.json`);
      const result = await run(["validator-possession-proof", "--genesis", genesisPath, "--key", await writeKey(dir, id), "--out", out]);
      assert.equal(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
      const proof = JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>;
      assert.deepEqual(Object.keys(proof).sort(), ["address", "signature"]);
      assert.equal(proof.address, addr(id));
      proofs.push(proof);
    }
    const byAddress = new Map(proofs.map((proof) => [(proof as { address: string }).address, proof]));
    const assembled = {
      ...genesis,
      validatorAdmission: {
        policy: POSSESSION_PROOF_POLICY_V1,
        genesisProofs: genesis.validators.map((validator) => byAddress.get(validator.address))
      }
    } as GenesisConfig;
    assert.doesNotThrow(() => assertGenesisPossessionProofs(assembled));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validator-possession-proof --genesis refuses a key that is not a genesis validator and writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-pop-genesis-stranger-"));
  try {
    const genesisPath = join(dir, "genesis.json");
    await writeFile(genesisPath, `${JSON.stringify(strictGenesis(), null, 2)}\n`);
    const out = join(dir, "proof.json");
    const result = await run(["validator-possession-proof", "--genesis", genesisPath, "--key", await writeKey(dir, 0x41), "--out", out]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not a genesis validator/);
    assert.equal(await exists(out), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validator-possession-proof --proposal signs for the update's activation height and the given genesis hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-pop-update-"));
  try {
    await writeProposalAndApprovals(dir);
    const out = await makeUpdateProof(dir, 0x31);
    const proof = JSON.parse(await readFile(out, "utf8")) as { address: string; signature: string };
    assert.deepEqual(Object.keys(proof).sort(), ["address", "signature"]);
    assert.equal(proof.address, addr(0x31));
    const statement = { chainId: CHAIN_ID, chainBinding: GENESIS_HASH, activationHeight: ACTIVATION, address: addr(0x31), publicKey: pub(0x31) };
    assert.equal(verifyPossessionProof(statement, proof.signature), true);
    assert.equal(verifyPossessionProof({ ...statement, activationHeight: 0 }, proof.signature), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validator-possession-proof --proposal refuses a key that is not in the proposed set, and a malformed genesis hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-pop-update-stranger-"));
  try {
    const { proposalPath } = await writeProposalAndApprovals(dir);
    const out = join(dir, "proof.json");
    const stranger = await run(["validator-possession-proof", "--proposal", proposalPath, "--genesis-hash", GENESIS_HASH, "--key", await writeKey(dir, 0x41), "--out", out]);
    assert.notEqual(stranger.code, 0);
    assert.match(stranger.stderr, /not in the proposed validator set/);
    const badHash = await run(["validator-possession-proof", "--proposal", proposalPath, "--genesis-hash", "XYZ", "--key", await writeKey(dir, 0x31), "--out", out]);
    assert.notEqual(badHash.code, 0);
    assert.match(badHash.stderr, /genesis-hash/);
    const both = await run(["validator-possession-proof", "--proposal", proposalPath, "--genesis", proposalPath, "--genesis-hash", GENESIS_HASH, "--key", await writeKey(dir, 0x31), "--out", out]);
    assert.notEqual(both.code, 0);
    assert.equal(await exists(out), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validator-submit --possession-proof attaches possessionProofs in proposal validator order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-pop-submit-"));
  const rpc = await startMockRpc();
  try {
    const { proposalPath, approvals } = await writeProposalAndApprovals(dir);
    const p31 = await makeUpdateProof(dir, 0x31);
    const p32 = await makeUpdateProof(dir, 0x32);
    const result = await run([
      "validator-submit", "--proposal", proposalPath,
      ...approvals.flatMap((path) => ["--approval", path]),
      // Given in reverse order on purpose.
      "--possession-proof", p32, "--possession-proof", p31,
      "--key", await writeKey(dir, 0x21), "--rpc", rpc.url
    ]);
    assert.equal(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(rpc.posted.length, 1);
    const tx = rpc.posted[0] as ValidatorSetUpdateTx;
    validateTransactionShape(tx);
    assert.deepEqual(tx.possessionProofs!.map((proof) => proof.address), [addr(0x31), addr(0x32)]);
    assert.deepEqual(tx.possessionProofs![0], JSON.parse(await readFile(p31, "utf8")));
  } finally {
    rpc.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("validator-submit refuses a proof for another chain, a duplicate, or an address outside the proposal, before RPC submission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-pop-submit-bad-"));
  const rpc = await startMockRpc();
  try {
    const { proposalPath, approvals } = await writeProposalAndApprovals(dir);
    const signer = await writeKey(dir, 0x21);
    const base = ["validator-submit", "--proposal", proposalPath, ...approvals.flatMap((path) => ["--approval", path]), "--key", signer, "--rpc", rpc.url];
    const wrongChain = await makeUpdateProof(dir, 0x31, OTHER_GENESIS_HASH);
    const good = await makeUpdateProof(dir, 0x31);
    const otherProposalPath = join(dir, "other-proposal.json");
    await writeFile(otherProposalPath, JSON.stringify({ ...proposal(), validators: [...proposal().validators, { address: addr(0x41), publicKey: pub(0x41) }] }));
    const outsider = await makeUpdateProof(dir, 0x41, GENESIS_HASH, otherProposalPath);

    const r1 = await run([...base, "--possession-proof", wrongChain]);
    assert.notEqual(r1.code, 0);
    assert.match(r1.stderr, /Invalid possession proof/);
    const r2 = await run([...base, "--possession-proof", good, "--possession-proof", good]);
    assert.notEqual(r2.code, 0);
    assert.match(r2.stderr, /Duplicate possession proof/);
    const r3 = await run([...base, "--possession-proof", outsider]);
    assert.notEqual(r3.code, 0);
    assert.match(r3.stderr, /not in the proposed validator set/);
    assert.equal(rpc.posted.length, 0);
  } finally {
    rpc.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("validator-submit without --possession-proof keeps the transaction unchanged (no possessionProofs field)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-pop-submit-none-"));
  const rpc = await startMockRpc();
  try {
    const { proposalPath, approvals } = await writeProposalAndApprovals(dir);
    const result = await run([
      "validator-submit", "--proposal", proposalPath, ...approvals.flatMap((path) => ["--approval", path]),
      "--key", await writeKey(dir, 0x21), "--rpc", rpc.url
    ]);
    assert.equal(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(Object.prototype.hasOwnProperty.call(rpc.posted[0], "possessionProofs"), false);
  } finally {
    rpc.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("published entrypoint stages possession-proof inputs: a symlinked proof is refused before key access", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-pop-secure-"));
  try {
    const { proposalPath, approvals } = await writeProposalAndApprovals(dir);
    const target = join(dir, "proof.json");
    const link = join(dir, "proof-link.json");
    await writeFile(target, "{}\n");
    await symlink(target, link);
    const submit = await run([
      "validator-submit", "--proposal", proposalPath, ...approvals.flatMap((path) => ["--approval", path]),
      "--possession-proof", link, "--key", join(dir, "missing-key.json"), "--rpc", "http://127.0.0.1:1"
    ], secureCli);
    assert.notEqual(submit.code, 0);
    assert.match(submit.stderr, /CLI governance artifact must not be a symbolic link/);
    const proposalLink = join(dir, "proposal-link.json");
    await symlink(proposalPath, proposalLink);
    const sign = await run([
      "validator-possession-proof", "--proposal", proposalLink, "--genesis-hash", GENESIS_HASH,
      "--key", join(dir, "missing-key.json"), "--out", join(dir, "out.json")
    ], secureCli);
    assert.notEqual(sign.code, 0);
    assert.match(sign.stderr, /CLI governance artifact must not be a symbolic link/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

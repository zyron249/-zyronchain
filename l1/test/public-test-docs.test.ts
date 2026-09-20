import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

async function findRepoRoot(start: string): Promise<string> {
  let current = start;
  for (let index = 0; index < 8; index += 1) {
    try {
      await stat(join(current, "README.md"));
      await stat(join(current, "l1", "package.json"));
      await stat(join(current, "docs", "l1-launch-authorization.json"));
      return current;
    } catch {
      current = resolve(current, "..");
    }
  }
  throw new Error("Could not locate the ZyronChain repository root");
}

const inventedPublicHosts = [
  "rpc.zyronchain.com",
  "explorer.zyronchain.com",
  "faucet.zyronchain.com",
  "testnet.zyronchain.com",
  "mainnet.zyronchain.com",
  "wss://"
];

test("public tester docs stay honest and do not invent hosted endpoints", async () => {
  const repoRoot = await findRepoRoot(process.cwd());
  const requiredFiles = [
    "docs/PUBLIC_TEST.md",
    "docs/PUBLIC_LAUNCH_CHECKLIST.md",
    "CONTRIBUTING.md",
    ".env.example",
    "l1/.env.example"
  ];
  for (const relative of requiredFiles) {
    const metadata = await stat(join(repoRoot, relative));
    assert.ok(metadata.isFile(), `${relative} must exist`);
  }

  const publicTest = await readFile(join(repoRoot, "docs/PUBLIC_TEST.md"), "utf8");
  const launchChecklist = await readFile(join(repoRoot, "docs/PUBLIC_LAUNCH_CHECKLIST.md"), "utf8");
  const contributing = await readFile(join(repoRoot, "CONTRIBUTING.md"), "utf8");
  const readme = await readFile(join(repoRoot, "README.md"), "utf8");
  const envExample = await readFile(join(repoRoot, ".env.example"), "utf8");
  const launcher = await readFile(join(repoRoot, "l1/scripts/local-devnet.mjs"), "utf8");
  const challenge = await readFile(join(repoRoot, "docs/INDEPENDENT_OPERATOR_CHALLENGE.md"), "utf8");
  const authorization = JSON.parse(
    await readFile(join(repoRoot, "docs/l1-launch-authorization.json"), "utf8")
  ) as {
    publicTestnetAuthorized: boolean;
    mainnetAuthorized: boolean;
    publicTestnetActivationAllowed: boolean;
    mainnetActivationAllowed: boolean;
    publicTestnetActivationRequirements: string[];
    mainnetActivationRequirements: string[];
  };

  for (const [label, text] of [
    ["docs/PUBLIC_TEST.md", publicTest],
    ["docs/PUBLIC_LAUNCH_CHECKLIST.md", launchChecklist],
    ["CONTRIBUTING.md", contributing],
    ["README.md", readme]
  ] as const) {
    for (const host of inventedPublicHosts) {
      assert.equal(text.toLowerCase().includes(host), false, `${label} must not invent ${host}`);
    }
  }

  for (const needle of [
    "npm run devnet",
    "publicTestnetActivationAllowed=false",
    "no hosted public L1 RPC",
    "not EVM",
    "no public faucet",
    "127.0.0.1",
    "zyron-local-",
    "MetaMask",
    "zyronchain.onrender.com",
    "npm run mine:local",
    "protocol v1"
  ]) {
    assert.ok(publicTest.includes(needle), `docs/PUBLIC_TEST.md missing required text: ${needle}`);
  }

  for (const needle of [
    "publicTestnetActivationAllowed",
    "npm run mine:local",
    "mining-contention-calibration-and-inclusion-fairness-evidence",
    "Do not invent public RPC",
    "127.0.0.1"
  ]) {
    assert.ok(launchChecklist.includes(needle), `docs/PUBLIC_LAUNCH_CHECKLIST.md missing required text: ${needle}`);
  }

  assert.ok(/do not use it/i.test(publicTest), "quarantined Render hostname must stay a warning");
  assert.ok(readme.includes("docs/PUBLIC_TEST.md"), "root README must point testers at the public-test guide");
  assert.ok(readme.includes("CONTRIBUTING.md"), "root README must point to CONTRIBUTING.md");
  assert.ok(contributing.includes("Do not invent launch facts"), "CONTRIBUTING.md must forbid invented launch facts");
  assert.ok(envExample.includes("do NOT auto-load"), ".env.example must say it is not auto-loaded");
  assert.ok(envExample.includes("ZYRON_KEYSTORE_PASSWORD_FILE"), ".env.example must document the keystore password file");
  assert.match(envExample, /^\s*#/, ".env.example must not assign live secrets");
  assert.ok(launcher.includes("docs/PUBLIC_TEST.md"), "local-devnet launcher must point at the tester guide");
  assert.ok(launcher.includes("docs/PUBLIC_LAUNCH_CHECKLIST.md"), "local-devnet launcher must point at the public-launch checklist");
  assert.ok(launcher.includes("MetaMask cannot connect"), "local-devnet launcher must warn that the chain is not EVM");
  assert.ok(launcher.includes("--local-v5"), "local-devnet launcher must expose the local v5 mining rehearsal flag");
  assert.ok(launcher.includes("cannot be combined"), "local-devnet --check must stay protocol v1");
  assert.ok(readme.includes("docs/PUBLIC_LAUNCH_CHECKLIST.md"), "root README must point at the public-launch checklist");
  assert.ok(contributing.includes("npm run mine:local"), "CONTRIBUTING.md must mention the local mining rehearsal");
  assert.ok(
    challenge.includes("publicTestnetActivationAllowed"),
    "independent-operator challenge must describe activation, not stale authorization flags"
  );
  assert.equal(challenge.includes("remain false in the repository policy"), false);
  assert.equal(authorization.publicTestnetAuthorized, true);
  assert.equal(authorization.mainnetAuthorized, true);
  assert.equal(authorization.publicTestnetActivationAllowed, false);
  assert.equal(authorization.mainnetActivationAllowed, false);
  for (const gate of [
    "independent-protocol-v5-mining-issuance-audit-and-retest",
    "mining-contention-calibration-and-inclusion-fairness-evidence",
    "independent-maintainer-and-security-custody-succession-evidence"
  ]) {
    assert.ok(
      authorization.publicTestnetActivationRequirements.includes(gate),
      `authorization JSON missing public-testnet gate: ${gate}`
    );
  }
  for (const gate of [
    "immutable-mining-reward-halving-cap-and-difficulty-policy",
    "sustained-public-testnet-mining-finality-and-independent-retest"
  ]) {
    assert.ok(
      authorization.mainnetActivationRequirements.includes(gate),
      `authorization JSON missing mainnet gate: ${gate}`
    );
  }
});

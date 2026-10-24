#!/usr/bin/env node
// ZyronChain fixed-supply verifier CLI (read-only). See docs/SUPPLY_VERIFIER.md.
// Exit codes: 0 verified, 1 verification failed (fail closed), 2 usage error.
import { readFile } from "node:fs/promises";

import { PINNED_GENESIS_HASH, readCapped, verifySupply } from "./src/verify.mjs";

const USAGE = `Usage: node tools/supply-verifier/cli.mjs --genesis <file|url> --endpoint <url> --endpoint <url> [...]
  --genesis <file|url>          genesis JSON (a GET /genesis body or a bare genesis config)
  --endpoint <url>              node RPC base serving GET /status and GET /blocks (repeat; at least 2)
                                For the open testnet gateway use <gateway>/peer.
  --expected-genesis-hash <hex> override the pinned genesis hash (default ${PINNED_GENESIS_HASH})
  --to-height <n>               verify up to this height (default: lowest endpoint tip)
  --timeout-ms <n>              per-request timeout (default 30000)
  --max-tip-drift <n>           warn when endpoint tips differ by more than n blocks (default 3)
  --json                        print the report as JSON
  --help`;

function parse(argv) {
  const options = { endpoints: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--endpoint") options.endpoints.push(value());
    else if (arg === "--genesis") options.genesis = value();
    else if (arg === "--expected-genesis-hash") options.expectedGenesisHash = value();
    else if (arg === "--to-height") options.toHeight = Number(value());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--max-tip-drift") options.maxTipDrift = Number(value());
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

async function loadGenesis(source, timeoutMs) {
  let text;
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(timeoutMs ?? 30_000), redirect: "error" });
    if (response.status !== 200) throw new Error(`genesis URL returned HTTP ${response.status}`);
    text = await readCapped(response, "genesis URL", "");
  } else {
    text = await readFile(source, "utf8");
  }
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && parsed.genesis && typeof parsed.genesis === "object" ? parsed.genesis : parsed;
}

let options;
try {
  options = parse(process.argv.slice(2));
  if (options.help) { console.log(USAGE); process.exit(0); }
  if (!options.genesis) throw new Error("--genesis is required");
} catch (error) {
  console.error(`${error.message}\n\n${USAGE}`);
  process.exit(2);
}

try {
  const genesis = await loadGenesis(options.genesis, options.timeoutMs);
  if (options.expectedGenesisHash && options.expectedGenesisHash !== PINNED_GENESIS_HASH) {
    console.error(`WARNING: verifying against a non-default genesis hash ${options.expectedGenesisHash}`);
  }
  const report = await verifySupply({
    ...options,
    genesis,
    onProgress: options.json ? undefined : ({ height, target }) => process.stderr.write(`replayed ${height}/${target}\r`)
  });
  for (const warning of report.warnings) console.error(`WARNING: ${warning}`);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    const zyn = (atoms) => { const a = BigInt(atoms); return `${a / 100_000_000n}.${(a % 100_000_000n).toString().padStart(8, "0")} ZYN`; };
    console.log(`OK: supply reconciles to exactly 50,000,000 ZYN at height ${report.height} (tip ${report.tipHash})`);
    console.log(`  genesis ${report.genesisHash} on ${report.chainId}, ${report.endpointsChecked} endpoints cross-checked`);
    for (const [name, value] of Object.entries(report.buckets)) console.log(`  ${name.padEnd(16)} ${zyn(value)}`);
    console.log(`  total            ${zyn(report.totalAtoms)}`);
    console.log("Trust assumptions:");
    for (const line of report.trustAssumptions) console.log(`  - ${line}`);
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
}

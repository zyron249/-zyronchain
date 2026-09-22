#!/usr/bin/env node
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

const roles = new Set(["validator", "bootstrap", "public-rpc", "archive", "monitoring"]);
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const role = option("--role");
if (!role || !roles.has(role)) {
  console.error("Usage: public-testnet-host-preflight --role validator|bootstrap|public-rpc|archive|monitoring [--data dir]");
  process.exit(1);
}
if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error("Node.js 22 or newer is required");
  process.exit(1);
}
if (typeof process.getuid === "function" && process.getuid() === 0) {
  console.error("Refusing to preflight a public-testnet role as root");
  process.exit(1);
}

const data = option("--data");
if (data) {
  const path = resolve(data);
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    console.error("Data directory is missing");
    process.exit(1);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    console.error("Data directory must be a real directory, not a symlink");
    process.exit(1);
  }
}

const checks = {
  validator: ["isolated host", "validator key only on this host", "consensus not on the public address", "persistent disk", "backup includes the signing journal"],
  bootstrap: ["assigned P2P port only", "no validator key", "no invented multiaddr"],
  "public-rpc": ["public role only", "no validator key", "no bootstrap key", "TLS at the proxy", "consensus routes denied"],
  archive: ["no validator key", "persistent disk", "backup required", "not the only copy of every validator"],
  monitoring: ["metrics not on the public address", "no validator key"]
};

process.stdout.write(`${JSON.stringify({
  role,
  result: "template-checked",
  started: false,
  checks: checks[role]
}, null, 2)}\n`);

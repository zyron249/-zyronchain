#!/usr/bin/env node
// Deterministic build of the supply-verifier release artifact.
//
//   node tools/supply-verifier/build.mjs [--clean-l1]
//
// --clean-l1 runs `npm ci` and a fresh `npm run build` in l1/ (pinned by
// l1/package-lock.json) before packing. The artifact is an uncompressed POSIX
// ustar archive with sorted paths, mtime 0, uid/gid 0, mode 0644 and no
// user/group names, so identical inputs give a byte-identical file. It holds
// the verifier sources, the compiled l1 consensus modules it imports
// (l1/dist/src/*.js) and the l1 manifest and lockfile for `npm ci`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const l1Dir = join(repo, "l1");
export const ARTIFACT = join(here, "dist", "zyron-supply-verifier.tar");

if (process.argv.includes("--clean-l1")) {
  rmSync(join(l1Dir, "dist"), { recursive: true, force: true });
  execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: l1Dir, stdio: "inherit" });
  execFileSync("npm", ["run", "build"], { cwd: l1Dir, stdio: "inherit" });
}

function walk(dir, filter) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, filter));
    else if (filter(path)) out.push(path);
  }
  return out;
}

const files = [
  join(here, "cli.mjs"),
  join(here, "package.json"),
  join(here, "package-lock.json"),
  ...walk(join(here, "src"), (p) => p.endsWith(".mjs")),
  join(l1Dir, "package.json"),
  join(l1Dir, "package-lock.json"),
  ...walk(join(l1Dir, "dist", "src"), (p) => p.endsWith(".js"))
];
const entries = files
  .map((path) => ({ name: relative(repo, path).split(sep).join("/"), data: readFileSync(path) }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
if (!entries.some((e) => e.name === "l1/dist/src/chain.js")) throw new Error("l1/dist/src is missing: build l1 first (or pass --clean-l1)");

function octal(value, width) { return value.toString(8).padStart(width - 1, "0") + "\0"; }
function header(name, size) {
  const block = Buffer.alloc(512);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`path too long for ustar: ${name}`);
  }
  block.write(base, 0, "utf8");
  block.write(octal(0o644, 8), 100);
  block.write(octal(0, 8), 108);
  block.write(octal(0, 8), 116);
  block.write(octal(size, 12), 124);
  block.write(octal(0, 12), 136);
  block.fill(" ", 148, 156);
  block.write("0", 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  block.write(prefix, 345, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7) + " ", 148);
  return block;
}

const parts = [];
for (const { name, data } of entries) {
  parts.push(header(name, data.length), data);
  const pad = (512 - (data.length % 512)) % 512;
  if (pad) parts.push(Buffer.alloc(pad));
}
parts.push(Buffer.alloc(1024));
const tar = Buffer.concat(parts);
mkdirSync(dirname(ARTIFACT), { recursive: true });
writeFileSync(ARTIFACT, tar);
const manifest = entries.map(({ name, data }) => `${createHash("sha256").update(data).digest("hex")}  ${name}`).join("\n") + "\n";
writeFileSync(join(dirname(ARTIFACT), "MANIFEST.sha256"), manifest);
console.log(`wrote ${relative(repo, ARTIFACT)} (${entries.length} files, ${tar.length} bytes)`);

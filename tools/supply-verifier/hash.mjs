#!/usr/bin/env node
// Prints the sha256 of the release artifact in sha256sum format.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const artifact = join(dirname(fileURLToPath(import.meta.url)), "dist", "zyron-supply-verifier.tar");
console.log(`${createHash("sha256").update(readFileSync(artifact)).digest("hex")}  zyron-supply-verifier.tar`);

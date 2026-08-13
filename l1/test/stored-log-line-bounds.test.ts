import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPrivate = "31".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const account = addressFromPublicKey(publicKeyFromPrivate("32".padStart(64, "0")));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("33".padStart(64, "0")));

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-stored-line-bounds-1",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: addressFromPublicKey(validatorPublic), publicKey: validatorPublic }],
    activityOracles: [publicKeyFromPrivate("34".padStart(64, "0"))],
    activityPool,
    allocations: [
      { address: account, amountAtoms: 1_000 },
      { address: activityPool, amountAtoms: 1_000 }
    ]
  };
}

async function withDirectory(name: string, run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `zyron-${name}-`));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const newline of [false, true]) {
  test(`finalized replay rejects oversized ${newline ? "newline-terminated" : "EOF-final"} line before JSON parsing`, async () => {
    await withDirectory(`block-line-${newline ? "nl" : "eof"}`, async (directory) => {
      await ChainStore.open(genesis(), directory);
      const oversized = Buffer.alloc(2_500_001, 0x61);
      const body = newline ? Buffer.concat([oversized, Buffer.from("\n")]) : oversized;
      await writeFile(join(directory, "blocks.ndjson"), body);
      await assert.rejects(
        ChainStore.open(genesis(), directory),
        /Stored block exceeds line limit/
      );
    });
  });
}

for (const newline of [false, true]) {
  test(`signing journal replay rejects oversized ${newline ? "newline-terminated" : "EOF-final"} line before JSON parsing`, async (context) => {
    if (process.platform === "win32") return context.skip("validator journal durability intentionally fails closed on Windows");
    await withDirectory(`journal-line-${newline ? "nl" : "eof"}`, async (directory) => {
      const initial = await SigningJournal.open(directory);
      initial.close();
      const oversized = Buffer.alloc(1_025, 0x61);
      const body = newline ? Buffer.concat([oversized, Buffer.from("\n")]) : oversized;
      await writeFile(join(directory, "signing-journal.ndjson"), body);
      await assert.rejects(
        SigningJournal.open(directory),
        /Corrupt signing journal/
      );
    });
  });
}

test("signing journal replay preserves CRLF compatibility at a valid bounded record", async (context) => {
  if (process.platform === "win32") return context.skip("validator journal durability intentionally fails closed on Windows");
  await withDirectory("journal-line-crlf", async (directory) => {
    const initial = await SigningJournal.open(directory);
    initial.close();
    const value = "ab".repeat(32);
    const line = `${JSON.stringify({ height: 7, round: 2, kind: "attest", value })}\r\n`;
    await writeFile(join(directory, "signing-journal.ndjson"), line, "utf8");
    const reopened = await SigningJournal.open(directory);
    try {
      await assert.rejects(
        reopened.reserveSkip(7, 2, "cd".repeat(32)),
        /Conflicting validator action prevented/
      );
    } finally {
      reopened.close();
    }
  });
});
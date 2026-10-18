// R26-1048-L1 (Codex on #1048, tracked as a Low): the open-testnet restore
// reported no progress while it copied, hashed and opened each validator's
// copy of the replayed log. The boot liveness check answers 503 after
// BOOT_STALL_MS without progress, so a long enough log would make a healthy,
// progressing restore look stalled and get the instance restarted.
//
// Every copy step must report progress: each copied file, each stored block
// record the copy's ChainStore.open reads (through the storage hook), and each
// hashed chunk of the byte-for-byte checks, including the final check of all
// copies right before the completion marker. Progress events are labelled so a
// caller (and these tests) can tell the steps apart.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
const FILES = ["metadata.json", "blocks.ndjson", "recovery-checkpoint.json"];
const COPIES = ["v2", "v3", "v4"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function sourceBundle(root: string, chainId: string): Promise<Json> {
  const source = join(root, "source");
  await api.initNetwork(source, chainId);
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const keys: Record<string, string> = {};
  for (const file of await readdir(join(source, "keys"))) keys[file.replace(/\.json$/, "")] = (await json(join(source, "keys", file))).privateKey;
  const blocks = (await readFile(join(source, "data-v1", "blocks.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { format: "ZYRON-OPEN-TESTNET-STATE-V1", genesis: await json(join(source, "genesis.json")), network: await json(join(source, "network.json")), keys, blocks };
}

test("restore reports progress for every validator copy step: copied files, records read by each copy's open, and hashed chunks", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-restore-progress-"));
  try {
    const bundle = await sourceBundle(root, "zyron-restore-progress-testnet-1");
    const target = join(root, "restored");
    const events: Json[] = [];
    const onProgress = (event?: Json) => {
      events.push({ ...(event ?? {}), present: event?.validator && event?.file ? existsSync(join(target, `data-${event.validator}`, event.file)) : undefined, marker: existsSync(join(target, "network.json")) });
    };
    const restored = await api.restoreNetwork(target, bundle, bundle.genesis.chainId, { onProgress });
    assert.equal(restored.height, bundle.blocks.length);
    assert.ok(await api.readNetworkMarker(target));
    assert.ok(events.every((event) => !event.marker), "every progress tick comes before the completion marker");

    const replayed = events.filter((event) => event.step === "replay-block").length;
    assert.equal(replayed, bundle.blocks.length, "one tick per replayed snapshot block");
    assert.equal(events.filter((event) => event.step === "checkpoint").length, 1, "a tick once the recovery checkpoint is written");

    for (const name of COPIES) {
      for (const file of FILES) {
        const copied = events.find((event) => event.step === "copy-file" && event.validator === name && event.file === file);
        assert.ok(copied, `no progress after copying ${file} to ${name}`);
        assert.ok(copied.present, `the ${name} ${file} tick came before the file was copied`);
        assert.ok(events.some((event) => event.step === "verify-chunk" && event.validator === name && event.file === file), `no progress while hashing ${name} ${file}`);
      }
      const records = events.filter((event) => event.step === "open-record" && event.validator === name).length;
      assert.ok(records >= bundle.blocks.length, `${name} open reported ${records} records for ${bundle.blocks.length} blocks`);
      assert.equal(events.filter((event) => event.step === "copy-opened" && event.validator === name).length, 1, `a tick once ${name} is opened`);
    }

    // The final byte-for-byte check of every copy (R28-1059-L1) runs after the
    // last copy is opened and must report progress for every file it hashes.
    const lastOpened = events.findIndex((event) => event.step === "copy-opened" && event.validator === COPIES.at(-1));
    const final = events.slice(lastOpened + 1).filter((event) => event.step === "verify-chunk");
    for (const name of ["v1", ...COPIES]) {
      for (const file of FILES) assert.ok(final.some((event) => event.validator === name && event.file === file), `no progress while re-checking ${name} ${file} before the marker`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

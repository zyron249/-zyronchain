import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadMaterialModule() {
  return import(new URL("../../scripts/render-testnet-material.mjs", import.meta.url).href);
}

test("Render testnet material safely reuses canonical persisted genesis and validator keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-render-material-"));
  try {
    const { loadOrCreateRenderTestnetMaterial } = await loadMaterialModule();
    const created = await loadOrCreateRenderTestnetMaterial(root, "zyron-render-material-test", 19400);
    assert.equal(created.reused, false);

    const reused = await loadOrCreateRenderTestnetMaterial(root, "zyron-render-material-test", 19400);
    assert.equal(reused.reused, true);
    assert.equal(reused.validatedGenesis.genesisHash, created.validatedGenesis.genesisHash);
    assert.deepEqual(
      reused.validators.map((validator: { address: string }) => validator.address),
      created.validators.map((validator: { address: string }) => validator.address)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Render testnet material rejects persisted validator-key symlink substitution", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation may require elevated Windows privileges");
  const root = await mkdtemp(join(tmpdir(), "zyron-render-material-link-"));
  try {
    const { loadOrCreateRenderTestnetMaterial } = await loadMaterialModule();
    await loadOrCreateRenderTestnetMaterial(root, "zyron-render-material-link-test", 19500);
    const keyPath = join(root, "validator-1.json");
    const targetPath = join(root, "validator-1-target.json");
    await rename(keyPath, targetPath);
    await symlink(targetPath, keyPath);
    await assert.rejects(
      loadOrCreateRenderTestnetMaterial(root, "zyron-render-material-link-test", 19500),
      /must not be a symbolic link/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Render testnet material rejects oversized persisted genesis before JSON parsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-render-material-size-"));
  try {
    const { loadOrCreateRenderTestnetMaterial } = await loadMaterialModule();
    await loadOrCreateRenderTestnetMaterial(root, "zyron-render-material-size-test", 19600);
    const genesisPath = join(root, "genesis.json");
    const original = await readFile(genesisPath, "utf8");
    assert.ok(original.length < 64 * 1024);
    await writeFile(genesisPath, "{" + " ".repeat(64 * 1024) + "}", { mode: 0o644 });
    await assert.rejects(
      loadOrCreateRenderTestnetMaterial(root, "zyron-render-material-size-test", 19600),
      /Existing Render genesis exceeds byte bounds or is not a regular file/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

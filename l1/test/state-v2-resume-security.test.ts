import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPortableStateResumeFile } from "../src/state-v2-resume.js";

test("portable State-v2 resume bounded reader accepts the exact byte boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-resume-boundary-"));
  const path = join(directory, "chunk.json");
  try {
    const text = "a".repeat(64);
    await writeFile(path, text, "utf8");
    assert.equal(await readPortableStateResumeFile(path, 64), text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable State-v2 resume bounded reader rejects an initially oversized file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-resume-oversized-"));
  const path = join(directory, "chunk.json");
  try {
    await writeFile(path, "a".repeat(65), "utf8");
    await assert.rejects(() => readPortableStateResumeFile(path, 64), /byte bounds/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable State-v2 resume bounded reader rejects concurrent growth after descriptor binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-resume-growth-"));
  const path = join(directory, "chunk.json");
  try {
    await writeFile(path, "a".repeat(32), "utf8");
    await assert.rejects(
      () => readPortableStateResumeFile(path, 64, {
        afterOpen: async () => { await appendFile(path, "b".repeat(40), "utf8"); }
      }),
      /byte bounds/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable State-v2 resume bounded reader rejects path replacement after descriptor binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-resume-replace-"));
  const path = join(directory, "chunk.json");
  const displaced = join(directory, "old.json");
  try {
    await writeFile(path, "canonical", "utf8");
    await assert.rejects(
      () => readPortableStateResumeFile(path, 64, {
        afterOpen: async () => {
          await rename(path, displaced);
          await writeFile(path, "replacement", "utf8");
        }
      }),
      /changed during bounded read/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable State-v2 resume bounded reader rejects an initial symlink", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-resume-symlink-"));
  const target = join(directory, "target.json");
  const path = join(directory, "chunk.json");
  try {
    await writeFile(target, "canonical", "utf8");
    await symlink(target, path);
    await assert.rejects(() => readPortableStateResumeFile(path, 64), /not a regular file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable State-v2 resume descriptor open refuses symlink substitution after preflight", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-resume-preopen-symlink-"));
  const path = join(directory, "chunk.json");
  const displaced = join(directory, "original.json");
  try {
    await writeFile(path, "canonical", "utf8");
    await assert.rejects(
      () => readPortableStateResumeFile(path, 64, {
        afterPreflight: async () => {
          await rename(path, displaced);
          await symlink(displaced, path);
        }
      }),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ELOOP")
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

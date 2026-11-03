// GET /health diagnostics: filesystem type of /tmp and the data dir, cgroup
// memory, shmem. Read-only, nothing else, null on any failure.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hd: any = await import(pathToFileURL(join(l1Root, "scripts/open-testnet/host-diag.mjs")).href);

const MOUNTS = [
  "overlay / overlay rw,relatime,lowerdir=/var/lib/secret-layer,upperdir=/x 0 0",
  "tmpfs /tmp tmpfs rw,nosuid,size=65536k 0 0",
  "tmpfs /etc/secrets tmpfs ro 0 0",
  "/dev/sda1 /data\\040dir ext4 rw 0 0"
].join("\n");
const files = (extra: Record<string, string> = {}) => ({
  "/proc/mounts": MOUNTS, "/proc/self/cgroup": "0::/app.slice\n",
  "/sys/fs/cgroup/app.slice/memory.current": "300000000\n", "/sys/fs/cgroup/app.slice/memory.max": "536870912\n",
  "/sys/fs/cgroup/app.slice/memory.stat": "anon 1\nfile 2\nshmem 157286400\nshmem_thp 0\n", ...extra
});
const reader = (map: Record<string, string>) => (p: string) => { if (!(p in map)) throw new Error("ENOENT"); return map[p]; };
const real = (p: string) => p;

test("reports only type and mount point for /tmp and the data dir, plus cgroup memory and shmem", () => {
  const out = hd.hostMemoryDiagnostics({ dataDir: "/tmp/zyron-open-testnet", read: reader(files()), real });
  assert.deepEqual(out, {
    filesystems: { tmp: { type: "tmpfs", mountPoint: "/tmp" }, dataDir: { type: "tmpfs", mountPoint: "/tmp" } },
    cgroup: { memoryCurrent: 300000000, memoryMax: 536870912, shmem: 157286400 }
  });
  const text = JSON.stringify(out);
  for (const leak of ["secret", "lowerdir", "size=", "rw", "/dev/sda1"]) assert.equal(text.includes(leak), false, leak);
  const other = hd.hostMemoryDiagnostics({ dataDir: "/data dir/net", read: reader(files()), real });
  assert.deepEqual(other.filesystems.dataDir, { type: "ext4", mountPoint: "/data dir" });
  assert.equal(hd.mountFor(hd.parseMounts(MOUNTS), "/tmpx").mountPoint, "/", "prefix match is per path segment");
});

test("fails soft: unreadable files give null, memory.max 'max' is kept, root cgroup works", () => {
  assert.deepEqual(hd.hostMemoryDiagnostics({ dataDir: "/x", read: reader({}), real }), { filesystems: { tmp: null, dataDir: null }, cgroup: { memoryCurrent: null, memoryMax: null, shmem: null } });
  const root = hd.hostMemoryDiagnostics({ dataDir: "/x", real, read: reader({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/memory.current": "12\n" }) });
  assert.deepEqual(root.cgroup, { memoryCurrent: 12, memoryMax: "max", shmem: null });
  const escape = hd.hostMemoryDiagnostics({ dataDir: "/x", real, read: reader({ "/proc/self/cgroup": "0::/../../etc\n" }) });
  assert.deepEqual(escape.cgroup, { memoryCurrent: null, memoryMax: null, shmem: null });
  const v1 = hd.hostMemoryDiagnostics({ dataDir: "/x", real, read: reader({ "/proc/self/cgroup": "4:memory:/docker/abc\n" }) });
  assert.equal(v1.cgroup.memoryCurrent, null);
});

test("live read on this host does not throw and is cached for the ttl", () => {
  let t = 0;
  const get = hd.createHostMemoryDiagnostics({ dataDir: process.cwd() }, { ttlMs: 1000, now: () => t });
  const a = get(); assert.ok(a && "filesystems" in a && "cgroup" in a);
  t = 500; assert.equal(get(), a); t = 1000; assert.notEqual(get(), a);
});

test("the default ttl clock is monotonic (performance.now), not wall-clock time", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(join(l1Root, "scripts/open-testnet/host-diag.mjs"), "utf8");
  assert.match(src, /createHostMemoryDiagnostics\([^)]*now = \(\) => performance\.now\(\)/);
  const realNow = Date.now; let calls = 0;
  Date.now = () => { calls += 1; return realNow(); };
  try { const get = hd.createHostMemoryDiagnostics({ dataDir: process.cwd() }); get(); get(); } finally { Date.now = realNow; }
  assert.equal(calls, 0, "a wall-clock jump cannot expire or freeze the cache");
});

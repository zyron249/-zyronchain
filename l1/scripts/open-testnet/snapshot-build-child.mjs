// Snapshot build child process (disk design). Started by the gateway with
// --max-old-space-size, so a runaway build fails on its own instead of
// pushing the gateway past the instance's memory. It streams the verified
// NDJSON history file (validated line by line, never trusted) through
// gzip and AES-256-GCM into an output file: memory stays at one line plus
// the stream buffers, whatever the chain length.
//
// IPC (parent -> child, once): { type: "build", view, head, secret, outPath, iv? }
// child -> parent: { type: "built", height, bytes } | { type: "failed", code, error }
// The state secret only arrives over IPC (never argv or env) and is only
// passed to the sealer. Error messages never include it.
import { open, rm } from "node:fs/promises";
import { readHistoryLines } from "./history-file.mjs";
import { sealJsonStream, snapshotHeader } from "./snapshot-seal.mjs";

async function writeAll(handle, buffer, position) {
  for (let offset = 0; offset < buffer.length;) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position === undefined ? null : position + offset);
    if (!(bytesWritten > 0)) throw new Error("snapshot output write made no progress");
    offset += bytesWritten;
  }
}

process.once("message", async (message) => {
  let reply;
  try {
    if (message?.type !== "build") throw new Error("unexpected message");
    const { view, head, secret, outPath } = message;
    const iv = message.iv ? Buffer.from(message.iv, "base64") : undefined;
    const handle = await open(outPath, "wx", 0o600);
    let bytes = 0;
    try {
      // Placeholder header; the tag is known only after the last block.
      const placeholder = snapshotHeader(Buffer.alloc(12), Buffer.alloc(16));
      await writeAll(handle, placeholder, 0); bytes = placeholder.length;
      const result = await sealJsonStream(head, readHistoryLines(view), secret, {
        ...(iv ? { iv } : {}),
        onChunk: async (chunk) => { await writeAll(handle, chunk, bytes); bytes += chunk.length; }
      });
      await writeAll(handle, snapshotHeader(result.iv, result.tag), 0);
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(outPath, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    reply = { type: "built", height: view.tip, bytes, maxRssKb: process.resourceUsage().maxRSS };
  } catch (error) {
    reply = { type: "failed", code: typeof error?.code === "string" ? error.code : undefined, error: error instanceof Error ? error.message : String(error) };
  }
  process.send(reply, () => process.exit(0));
});

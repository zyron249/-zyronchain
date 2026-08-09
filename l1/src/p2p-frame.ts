import type { Stream } from "@libp2p/interface";

const WRITE_CHUNK_BYTES = 64 * 1_024;
export const DEFAULT_P2P_INBOUND_FRAME_BUDGET_BYTES = 64 * 1_024 * 1_024;

export class P2PFrameByteBudget {
  private bytesInUse = 0;

  constructor(readonly maxBytes: number = DEFAULT_P2P_INBOUND_FRAME_BUDGET_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1_024 * 1_024) {
      throw new Error("Invalid P2P frame byte budget");
    }
  }

  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.maxBytes ||
        this.bytesInUse > this.maxBytes - bytes) {
      throw new Error("P2P inbound frame byte budget exceeded");
    }
    this.bytesInUse += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.bytesInUse -= bytes;
    };
  }
}

const inboundFrameBudget = new P2PFrameByteBudget();

export async function writeP2PFrame(stream: Stream, value: unknown, maxBytes: number, timeoutMs: number): Promise<void> {
  assertFrameLimits(maxBytes, timeoutMs);
  stream.inactivityTimeout = timeoutMs;
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > maxBytes) throw new Error("P2P frame too large");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  await sendChunk(stream, header, timeoutMs);
  for (let offset = 0; offset < body.length; offset += WRITE_CHUNK_BYTES) {
    await sendChunk(stream, body.subarray(offset, Math.min(body.length, offset + WRITE_CHUNK_BYTES)), timeoutMs);
  }
  // Every native protocol uses one request or response per libp2p stream.
  // Half-close the writable side so the receiver can authenticate the frame
  // boundary instead of accepting bytes that arrive in a later transport chunk.
  await stream.close({ signal: AbortSignal.timeout(timeoutMs) });
}

export async function readP2PFrame(
  stream: Stream,
  maxBytes: number,
  timeoutMs: number,
  budget: P2PFrameByteBudget = inboundFrameBudget
): Promise<unknown> {
  assertFrameLimits(maxBytes, timeoutMs);
  stream.inactivityTimeout = timeoutMs;
  const header = Buffer.alloc(4);
  let headerBytes = 0;
  let expectedBytes: number | undefined;
  let body: Buffer | undefined;
  let bodyBytes = 0;
  let decoded: unknown;
  let decodedFrame = false;
  let release: (() => void) | undefined;
  const timeout = setTimeout(() => stream.abort(new Error("P2P frame read timeout")), timeoutMs);
  timeout.unref();
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk.subarray());
      if (decodedFrame) {
        if (bytes.length > 0) throw new Error("Trailing bytes in P2P frame");
        continue;
      }
      let offset = 0;
      if (expectedBytes === undefined) {
        const take = Math.min(4 - headerBytes, bytes.length);
        bytes.copy(header, headerBytes, 0, take);
        headerBytes += take;
        offset += take;
        if (headerBytes === 4) {
          expectedBytes = header.readUInt32BE(0);
          if (expectedBytes < 1 || expectedBytes > maxBytes) throw new Error("Invalid P2P frame length");
          release = budget.reserve(expectedBytes);
          body = Buffer.allocUnsafe(expectedBytes);
        }
      }
      if (expectedBytes !== undefined && body) {
        const remaining = expectedBytes - bodyBytes;
        const take = Math.min(remaining, bytes.length - offset);
        if (take > 0) bytes.copy(body, bodyBytes, offset, offset + take);
        bodyBytes += take;
        offset += take;
        if (bodyBytes === expectedBytes) {
          if (offset !== bytes.length) throw new Error("Trailing bytes in P2P frame");
          try {
            decoded = JSON.parse(body.toString("utf8")) as unknown;
            decodedFrame = true;
          } catch {
            throw new Error("Invalid P2P frame encoding");
          }
        }
      }
    }
    if (decodedFrame) return decoded;
    throw new Error("Truncated P2P frame");
  } finally {
    clearTimeout(timeout);
    release?.();
  }
}

async function sendChunk(stream: Stream, bytes: Uint8Array, timeoutMs: number): Promise<void> {
  if (!stream.send(bytes)) await stream.onDrain({ signal: AbortSignal.timeout(timeoutMs) });
}

function assertFrameLimits(maxBytes: number, timeoutMs: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32_000_000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Invalid P2P frame limits");
  }
}

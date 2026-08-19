import type { Stream } from "@libp2p/interface";

const WRITE_CHUNK_BYTES = 64 * 1_024;
export const DEFAULT_P2P_INBOUND_FRAME_BUDGET_BYTES = 64 * 1_024 * 1_024;

export interface P2PFrameByteBudgetMetrics {
  bytesInUse: number;
  maxBytes: number;
  peakBytesInUse: number;
  rejectedFrames: number;
}

export class P2PFrameByteBudget {
  private bytesInUse = 0;
  private peakBytesInUse = 0;
  private rejectedFrames = 0;

  constructor(readonly maxBytes: number = DEFAULT_P2P_INBOUND_FRAME_BUDGET_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1_024 * 1_024) {
      throw new Error("Invalid P2P frame byte budget");
    }
  }

  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.maxBytes ||
        this.bytesInUse > this.maxBytes - bytes) {
      this.rejectedFrames += 1;
      throw new Error("P2P frame byte budget exceeded");
    }
    this.bytesInUse += bytes;
    this.peakBytesInUse = Math.max(this.peakBytesInUse, this.bytesInUse);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.bytesInUse -= bytes;
    };
  }

  metrics(): P2PFrameByteBudgetMetrics {
    return {
      bytesInUse: this.bytesInUse,
      maxBytes: this.maxBytes,
      peakBytesInUse: this.peakBytesInUse,
      rejectedFrames: this.rejectedFrames
    };
  }
}

const inboundFrameBudget = new P2PFrameByteBudget();
const outboundFrameBudget = new P2PFrameByteBudget();

export function nativeP2PFrameBudgetMetrics(): {
  inbound: P2PFrameByteBudgetMetrics;
  outbound: P2PFrameByteBudgetMetrics;
} {
  return {
    inbound: inboundFrameBudget.metrics(),
    outbound: outboundFrameBudget.metrics()
  };
}

export async function writeP2PFrame(
  stream: Stream,
  value: unknown,
  maxBytes: number,
  timeoutMs: number,
  budget: P2PFrameByteBudget = outboundFrameBudget
): Promise<void> {
  assertFrameLimits(maxBytes, timeoutMs);
  stream.inactivityTimeout = timeoutMs;
  // Serialization transiently retains both the JSON string and its encoded
  // Buffer. Reserve both frame-sized copies before either allocation and keep
  // them held through the slow-reader/stream-close boundary.
  const releaseSerialization = budget.reserve(maxBytes);
  let releaseEncoded: (() => void) | undefined;
  try {
    releaseEncoded = budget.reserve(maxBytes);
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
  } finally {
    releaseEncoded?.();
    releaseSerialization();
  }
}

export interface RetainedP2PFrame {
  value: unknown;
  release: () => void;
}

export async function readP2PFrame(
  stream: Stream,
  maxBytes: number,
  timeoutMs: number,
  budget: P2PFrameByteBudget = inboundFrameBudget
): Promise<unknown> {
  const retained = await readP2PFrameRetained(stream, maxBytes, timeoutMs, budget);
  try {
    return retained.value;
  } finally {
    retained.release();
  }
}

export async function readP2PFrameRetained(
  stream: Stream,
  maxBytes: number,
  timeoutMs: number,
  budget: P2PFrameByteBudget = inboundFrameBudget
): Promise<RetainedP2PFrame> {
  assertFrameLimits(maxBytes, timeoutMs);
  stream.inactivityTimeout = timeoutMs;
  const header = Buffer.alloc(4);
  let headerBytes = 0;
  let expectedBytes: number | undefined;
  let body: Buffer | undefined;
  let bodyBytes = 0;
  let decoded: unknown;
  let decodedFrame = false;
  let bodyRelease: (() => void) | undefined;
  let decodedRelease: (() => void) | undefined;
  let ownershipTransferred = false;
  const timeout = setTimeout(() => stream.abort(new Error("P2P frame read timeout")), timeoutMs);
  timeout.unref();
  try {
    for await (const chunk of stream) {
      // Inspect the transport-owned view before any user-space copy. A valid
      // single chunk can never exceed the complete 4-byte header + max body
      // envelope, so reject allocation-amplifying chunks before parsing.
      const bytes = chunk.subarray();
      if (bytes.byteLength > maxBytes + 4) throw new Error("P2P transport chunk exceeds frame limit");
      if (decodedFrame) {
        if (bytes.length > 0) throw new Error("Trailing bytes in P2P frame");
        continue;
      }
      let offset = 0;
      if (expectedBytes === undefined) {
        const take = Math.min(4 - headerBytes, bytes.length);
        header.set(bytes.subarray(0, take), headerBytes);
        headerBytes += take;
        offset += take;
        if (headerBytes === 4) {
          expectedBytes = header.readUInt32BE(0);
          if (expectedBytes < 1 || expectedBytes > maxBytes) throw new Error("Invalid P2P frame length");
          bodyRelease = budget.reserve(expectedBytes);
          body = Buffer.allocUnsafe(expectedBytes);
        }
      }
      if (expectedBytes !== undefined && body) {
        const remaining = expectedBytes - bodyBytes;
        const take = Math.min(remaining, bytes.length - offset);
        if (take > 0) body.set(bytes.subarray(offset, offset + take), bodyBytes);
        bodyBytes += take;
        offset += take;
        if (bodyBytes === expectedBytes) {
          if (offset !== bytes.length) throw new Error("Trailing bytes in P2P frame");
          try {
            // Decoding duplicates retained data into a JS string/object graph.
            // Reserve a second frame-sized allowance before creating that copy
            // and hold it until the caller releases the decoded value.
            decodedRelease = budget.reserve(expectedBytes);
            decoded = JSON.parse(body.toString("utf8")) as unknown;
            decodedFrame = true;
          } catch (error) {
            if (error instanceof Error && error.message === "P2P frame byte budget exceeded") throw error;
            throw new Error("Invalid P2P frame encoding");
          }
        }
      }
    }
    if (!decodedFrame || !bodyRelease || !decodedRelease) throw new Error("Truncated P2P frame");
    ownershipTransferred = true;
    let released = false;
    return {
      value: decoded,
      release: () => {
        if (released) return;
        released = true;
        decodedRelease?.();
        bodyRelease?.();
      }
    };
  } finally {
    clearTimeout(timeout);
    if (!ownershipTransferred) {
      decodedRelease?.();
      bodyRelease?.();
    }
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

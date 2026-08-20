import type { TransactionVersion } from "./transaction.js";
import { enforceCanonicalCliSecurityPolicy } from "./cli-policy.js";
import { assertRpcResponseVersion } from "./rpc-response-version.js";

enforceCanonicalCliSecurityPolicy(process.argv.slice(2));

export const MAX_RPC_CLIENT_JSON_NESTING_DEPTH = 64;
export const MAX_RPC_CLIENT_JSON_STRUCTURAL_TOKENS = 250_000;

export function transactionVersionForProtocolVersion(protocolVersion: number): TransactionVersion {
  if (!Number.isSafeInteger(protocolVersion)) throw new Error("RPC returned invalid protocol status");
  if (protocolVersion === 1 || protocolVersion === 2) return 1;
  if (protocolVersion === 3 || protocolVersion === 5) return 2;
  throw new Error("RPC returned unsupported next protocol version");
}

export function assertRpcApiVersion(response: Response, expectedVersion: number): void {
  assertRpcResponseVersion(response, expectedVersion, "RPC server");
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  label = "RPC response"
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid RPC response byte limit");
  const declared = response.headers.get("content-length");
  let declaredBytes: number | undefined;
  if (declared !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declared)) throw new Error(`${label} has invalid Content-Length`);
    declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) throw new Error(`${label} too large`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  // Keep one bounded destination buffer instead of retaining every transport
  // chunk and then allocating a second full contiguous copy. When a trustworthy
  // Content-Length is present allocate exactly that size; otherwise the caller's
  // existing maxBytes limit is the hard allocation ceiling.
  const capacity = declaredBytes ?? maxBytes;
  const bytes = new Uint8Array(capacity);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value.byteLength > maxBytes - total || value.byteLength > bytes.byteLength - total) {
        try { await reader.cancel("RPC response byte limit exceeded"); } catch { /* best effort */ }
        throw new Error(`${label} too large`);
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredBytes !== undefined && total !== declaredBytes) throw new Error(`${label} has mismatched Content-Length`);
  return new TextDecoder().decode(bytes.subarray(0, total));
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  label = "RPC response"
): Promise<unknown> {
  const text = await readBoundedResponseText(response, maxBytes, label);
  // Scan the already-bounded decoded string without creating another full byte
  // representation. Structural JSON punctuation is ASCII, so UTF-16 code-unit
  // inspection preserves the same string/escape boundaries needed for the quota.
  assertBoundedJsonStructure(text, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function assertBoundedJsonStructure(text: string, label: string): void {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let tokens = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (code === 0x5c) {
        escaped = true;
        continue;
      }
      if (code === 0x22) inString = false;
      continue;
    }

    if (code === 0x22) {
      inString = true;
      continue;
    }

    if (code === 0x7b || code === 0x5b) {
      depth += 1;
      tokens += 1;
      if (depth > MAX_RPC_CLIENT_JSON_NESTING_DEPTH) throw new Error(`${label} JSON complexity exceeded`);
    } else if (code === 0x7d || code === 0x5d) {
      depth = Math.max(0, depth - 1);
      tokens += 1;
    } else if (code === 0x2c || code === 0x3a) {
      tokens += 1;
    }

    if (tokens > MAX_RPC_CLIENT_JSON_STRUCTURAL_TOKENS) throw new Error(`${label} JSON complexity exceeded`);
  }
}

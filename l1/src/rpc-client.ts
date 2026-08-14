import type { TransactionVersion } from "./transaction.js";
import { enforceCanonicalCliSecurityPolicy } from "./cli-policy.js";
import { assertRpcResponseVersion } from "./rpc-response-version.js";

enforceCanonicalCliSecurityPolicy(process.argv.slice(2));

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
  if (declared !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declared)) throw new Error(`${label} has invalid Content-Length`);
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw new Error(`${label} too large`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value.byteLength > maxBytes - total) {
        try { await reader.cancel("RPC response byte limit exceeded"); } catch { /* best effort */ }
        throw new Error(`${label} too large`);
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  label = "RPC response"
): Promise<unknown> {
  const text = await readBoundedResponseText(response, maxBytes, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

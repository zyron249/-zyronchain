const DEFAULT_MAX_JSON_DEPTH = 64;
const DEFAULT_MAX_STRUCTURAL_TOKENS = 250_000;
const DEFAULT_UNDECLARED_INITIAL_BYTES = 4 * 1024;

export async function readBoundedJsonResponse(response, maxBytes, options = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid RPC response byte limit");
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_JSON_DEPTH;
  const maxStructuralTokens = options.maxStructuralTokens ?? DEFAULT_MAX_STRUCTURAL_TOKENS;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new Error("Invalid JSON depth limit");
  if (!Number.isSafeInteger(maxStructuralTokens) || maxStructuralTokens < 1) throw new Error("Invalid JSON structural-token limit");

  const declaredHeader = response.headers.get("content-length");
  let declaredBytes = null;
  if (declaredHeader !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredHeader)) throw new Error("RPC returned invalid Content-Length");
    declaredBytes = Number(declaredHeader);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      throw new Error(`RPC response exceeds ${formatByteLimit(maxBytes)} limit`);
    }
  }

  if (!response.body) {
    if (declaredBytes !== null && declaredBytes !== 0) throw new Error("RPC response length mismatch");
    throw new Error("RPC returned an empty body");
  }

  let capacity = declaredBytes ?? Math.min(maxBytes, DEFAULT_UNDECLARED_INITIAL_BYTES);
  let bytes = Buffer.allocUnsafe(capacity);
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const required = total + value.byteLength;
      if (required > maxBytes || (declaredBytes !== null && required > declaredBytes)) {
        await reader.cancel("response-too-large");
        throw new Error(`RPC response exceeds ${formatByteLimit(maxBytes)} limit`);
      }
      if (required > capacity) {
        capacity = Math.min(maxBytes, Math.max(required, Math.max(1, capacity) * 2));
        const grown = Buffer.allocUnsafe(capacity);
        bytes.copy(grown, 0, 0, total);
        bytes = grown;
      }
      bytes.set(value, total);
      total = required;
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredBytes !== null && total !== declaredBytes) throw new Error("RPC response length mismatch");
  const body = bytes.subarray(0, total);
  assertJsonComplexity(body, maxDepth, maxStructuralTokens);
  const text = body.toString("utf8");
  try {
    return { value: JSON.parse(text), text };
  } catch {
    throw new Error("RPC returned invalid JSON");
  }
}

export function assertJsonComplexity(bytes, maxDepth = DEFAULT_MAX_JSON_DEPTH, maxStructuralTokens = DEFAULT_MAX_STRUCTURAL_TOKENS) {
  let depth = 0;
  let structuralTokens = 0;
  let inString = false;
  let escaped = false;

  for (const byte of bytes) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (byte === 0x5c) {
        escaped = true;
        continue;
      }
      if (byte === 0x22) inString = false;
      continue;
    }

    if (byte === 0x22) {
      inString = true;
      continue;
    }

    if (byte === 0x7b || byte === 0x5b) {
      depth += 1;
      structuralTokens += 1;
      if (depth > maxDepth) throw new Error("RPC JSON nesting limit exceeded");
    } else if (byte === 0x7d || byte === 0x5d) {
      depth -= 1;
      structuralTokens += 1;
      if (depth < 0) throw new Error("RPC returned invalid JSON structure");
    } else if (byte === 0x2c || byte === 0x3a) {
      structuralTokens += 1;
    }

    if (structuralTokens > maxStructuralTokens) throw new Error("RPC JSON structural-token limit exceeded");
  }
}

function formatByteLimit(maxBytes) {
  if (maxBytes === 64 * 1024) return "64 KiB";
  return `${maxBytes} byte`;
}

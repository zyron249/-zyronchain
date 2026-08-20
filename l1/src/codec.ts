import { createHash } from "node:crypto";

/** Locale-independent lexicographic ordering over ECMAScript UTF-16 strings. */
export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Canonical protocol values are intentionally shallow fixed-shape records. Keep
 * a generous consensus-wide ceiling so hostile, pre-validation JSON cannot
 * exhaust the JavaScript call stack while leaving all legitimate objects far
 * below the boundary.
 */
export const MAX_CANONICAL_JSON_DEPTH = 64;

function normalize(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
  if (Array.isArray(value)) {
    assertCanonicalContainerBoundary(value, depth, ancestors);
    ancestors.add(value);
    try {
      return value.map((item) => normalize(item, depth + 1, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    assertCanonicalContainerBoundary(object, depth, ancestors);
    ancestors.add(object);
    try {
      return Object.fromEntries(
        Object.entries(object)
          // Consensus ordering must not depend on ICU data or the host locale.
          // JavaScript relational string comparison is defined over UTF-16 code
          // units, so this comparator has identical results on every runtime.
          .sort(([left], [right]) => compareCanonicalStrings(left, right))
          .map(([key, item]) => [key, normalize(item, depth + 1, ancestors)])
      );
    } finally {
      ancestors.delete(object);
    }
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("Consensus numbers must be safe integers");
  }
  return value;
}

function assertCanonicalContainerBoundary(value: object, depth: number, ancestors: Set<object>): void {
  if (depth > MAX_CANONICAL_JSON_DEPTH) throw new Error("Canonical JSON nesting depth exceeded");
  if (ancestors.has(value)) throw new Error("Canonical JSON must not contain cycles");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export interface CanonicalJsonDigest {
  byteLength: number;
  sha256: string;
}

const CANONICAL_STRING_CHUNK_CODE_UNITS = 16 * 1024;

/**
 * Computes the exact canonical JSON UTF-8 length and SHA-256 without building
 * the normalized object clone or one full canonical output string. This is for
 * already-parsed JSON-compatible values at memory-sensitive verification
 * boundaries; consensus serialization continues to use canonicalJson().
 */
export function canonicalJsonDigest(value: unknown): CanonicalJsonDigest {
  const hash = createHash("sha256");
  let byteLength = 0;
  const write = (fragment: string): void => {
    byteLength += Buffer.byteLength(fragment, "utf8");
    hash.update(fragment, "utf8");
  };
  emitCanonicalJson(value, write, 0, new Set<object>(), "root");
  return { byteLength, sha256: hash.digest("hex") };
}

function emitCanonicalJson(
  value: unknown,
  write: (fragment: string) => void,
  depth: number,
  ancestors: Set<object>,
  position: "root" | "array" | "object"
): void {
  if (Array.isArray(value)) {
    assertCanonicalContainerBoundary(value, depth, ancestors);
    ancestors.add(value);
    try {
      write("[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) write(",");
        const item = value[index];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") write("null");
        else emitCanonicalJson(item, write, depth + 1, ancestors, "array");
      }
      write("]");
    } finally {
      ancestors.delete(value);
    }
    return;
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    assertCanonicalContainerBoundary(object, depth, ancestors);
    ancestors.add(object);
    try {
      const entries = Object.entries(object)
        .filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
        .sort(([left], [right]) => compareCanonicalStrings(left, right));
      write("{");
      for (let index = 0; index < entries.length; index += 1) {
        if (index > 0) write(",");
        const [key, item] = entries[index]!;
        writeCanonicalString(key, write);
        write(":");
        emitCanonicalJson(item, write, depth + 1, ancestors, "object");
      }
      write("}");
    } finally {
      ancestors.delete(object);
    }
    return;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Consensus numbers must be safe integers");
    write(Object.is(value, -0) ? "0" : String(value));
    return;
  }
  if (typeof value === "string") {
    writeCanonicalString(value, write);
    return;
  }
  if (typeof value === "boolean") {
    write(value ? "true" : "false");
    return;
  }
  if (value === null) {
    write("null");
    return;
  }
  if (position === "array" && (value === undefined || typeof value === "function" || typeof value === "symbol")) {
    write("null");
    return;
  }
  throw new Error("Canonical JSON digest requires a JSON-compatible value");
}

function writeCanonicalString(value: string, write: (fragment: string) => void): void {
  write("\"");
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + CANONICAL_STRING_CHUNK_CODE_UNITS);
    if (end < value.length) {
      const last = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end += 1;
    }
    const encoded = JSON.stringify(value.slice(start, end));
    write(encoded.slice(1, -1));
    start = end;
  }
  write("\"");
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertHex(value: string, bytes: number, name: string): void {
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} must be ${bytes} bytes of lowercase hex`);
  }
}

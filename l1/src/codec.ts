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

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertHex(value: string, bytes: number, name: string): void {
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} must be ${bytes} bytes of lowercase hex`);
  }
}

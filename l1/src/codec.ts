import { createHash } from "node:crypto";

/** Locale-independent lexicographic ordering over ECMAScript UTF-16 strings. */
export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        // Consensus ordering must not depend on ICU data or the host locale.
        // JavaScript relational string comparison is defined over UTF-16 code
        // units, so this comparator has identical results on every runtime.
        .sort(([left], [right]) => compareCanonicalStrings(left, right))
        .map(([key, item]) => [key, normalize(item)])
    );
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("Consensus numbers must be safe integers");
  }
  return value;
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

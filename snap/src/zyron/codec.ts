/**
 * Port of l1/src/codec.ts `canonicalJson` and `sha256Hex` for the Snap
 * sandbox (no node:crypto / Buffer). Equality with l1 is proven by the Jest
 * suite, which compares Snap output byte-for-byte with the real l1 code.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const MAX_CANONICAL_JSON_DEPTH = 64;

/**
 * Locale-independent ordering over UTF-16 code units (same as l1).
 *
 * @param left - Left string.
 * @param right - Right string.
 * @returns Negative, zero or positive.
 */
function compareCanonicalStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * Recursively sorts object keys and rejects non-safe-integer numbers.
 *
 * @param value - Value to normalize.
 * @param depth - Current depth.
 * @param ancestors - Cycle detection set.
 * @returns The normalized value.
 */
function normalize(
  value: unknown,
  depth = 0,
  ancestors = new Set<object>(),
): unknown {
  if (Array.isArray(value)) {
    assertBoundary(value, depth, ancestors);
    ancestors.add(value);
    try {
      return value.map((item) => normalize(item, depth + 1, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    assertBoundary(object, depth, ancestors);
    ancestors.add(object);
    try {
      return Object.fromEntries(
        Object.entries(object)
          .sort(([left], [right]) => compareCanonicalStrings(left, right))
          .map(([key, item]) => [key, normalize(item, depth + 1, ancestors)]),
      );
    } finally {
      ancestors.delete(object);
    }
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('Consensus numbers must be safe integers');
  }
  return value;
}

/**
 * Depth and cycle guard.
 *
 * @param value - Container.
 * @param depth - Depth.
 * @param ancestors - Ancestors.
 */
function assertBoundary(
  value: object,
  depth: number,
  ancestors: Set<object>,
): void {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new Error('Canonical JSON nesting depth exceeded');
  }
  if (ancestors.has(value)) {
    throw new Error('Canonical JSON must not contain cycles');
  }
}

/**
 * Canonical JSON exactly as l1 computes it.
 *
 * @param value - Value to serialize.
 * @returns Canonical JSON string.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/**
 * Lowercase hex SHA-256 of a UTF-8 string or bytes (same as l1).
 *
 * @param value - Input.
 * @returns Hex digest.
 */
export function sha256Hex(value: string | Uint8Array): string {
  return bytesToHex(sha256(typeof value === 'string' ? utf8ToBytes(value) : value));
}

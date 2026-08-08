import { canonicalJson, sha256Hex } from "./codec.js";

export function merkleRoot(values: unknown[]): string {
  if (values.length === 0) return sha256Hex("");
  let level = values.map((value) => sha256Hex(canonicalJson(value)));
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]!);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256Hex(Buffer.from(`${level[i]}${level[i + 1]}`, "hex")));
    }
    level = next;
  }
  return level[0]!;
}

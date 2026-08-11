import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export async function assertPrivateRegularFile(path: string, label: string): Promise<void> {
  const resolved = resolve(path);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be readable, writable, or executable by group/other users (0600 recommended)`);
  }
}

export function normalizeSecureRpcUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("RPC URL must use HTTP(S)");
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid RPC URL");
  if (url.protocol === "http:" && !isLoopbackRpcHost(url.hostname)) {
    throw new Error("Remote RPC URL must use HTTPS; plaintext HTTP is allowed only for loopback");
  }
  return url.toString().replace(/\/$/, "");
}

export function isLoopbackRpcHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

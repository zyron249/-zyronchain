/**
 * Interactive, non-echoing password entry for the local CLI, plus a simple strength check
 * for newly chosen keystore passwords. Nothing here writes a password to disk.
 */

/** Reads one line from the controlling TTY without echoing it. Refuses non-interactive stdin. */
export async function promptHiddenLine(label: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("No interactive terminal: set ZYRON_KEYSTORE_PASSWORD_FILE (0600 file) or run in a terminal");
  }
  process.stderr.write(label);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  try {
    return await new Promise<string>((resolvePromise, reject) => {
      let value = "";
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === "\r" || char === "\n") {
            input.off("data", onData);
            process.stderr.write("\n");
            resolvePromise(value);
            return;
          }
          if (char === "\u0003") {
            input.off("data", onData);
            process.stderr.write("\n");
            reject(new Error("Password entry cancelled"));
            return;
          }
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else if (value.length < 1_024) value += char;
        }
      };
      input.on("data", onData);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
  }
}

export interface PasswordStrength {
  ok: boolean;
  bits: number;
  reason: string;
}

/**
 * Simple strength estimate: length x log2(character pool), plus a repetition guard.
 * Pool: 26 lower, 26 upper, 10 digits, 33 ASCII symbols/space, 100 for any non-ASCII.
 * Requires >= 12 characters, >= 6 distinct characters and >= 60 estimated bits.
 * This mirrors website/wallet-core.js passwordStrength().
 */
export function passwordStrength(password: string): PasswordStrength {
  const chars = Array.from(password);
  let lower = false;
  let upper = false;
  let digit = false;
  let symbol = false;
  let other = false;
  for (const char of chars) {
    const code = char.codePointAt(0)!;
    if (code >= 97 && code <= 122) lower = true;
    else if (code >= 65 && code <= 90) upper = true;
    else if (code >= 48 && code <= 57) digit = true;
    else if (code >= 32 && code <= 126) symbol = true;
    else other = true;
  }
  const pool = (lower ? 26 : 0) + (upper ? 26 : 0) + (digit ? 10 : 0) + (symbol ? 33 : 0) + (other ? 100 : 0);
  const bits = pool > 0 ? Math.floor(chars.length * Math.log2(pool)) : 0;
  const distinct = new Set(chars).size;
  if (chars.length < 12) return { ok: false, bits, reason: "Password must contain at least 12 characters" };
  if (distinct < 6) return { ok: false, bits, reason: "Password is too repetitive (fewer than 6 distinct characters)" };
  if (bits < 60) {
    return { ok: false, bits, reason: `Password is too weak (~${bits} bits estimated; need 60+). Use a longer passphrase or mix character types` };
  }
  return { ok: true, bits, reason: "" };
}

export function assertPasswordStrength(password: string): void {
  const result = passwordStrength(password);
  if (!result.ok) throw new Error(result.reason);
}

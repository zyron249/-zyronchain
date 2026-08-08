import { isIP } from "node:net";

import { assertExactKeys, assertPlainRecord } from "./transaction.js";
import { assertHex } from "./codec.js";
import { publicKeyFromPrivate, signCanonical, verifyCanonical } from "./crypto.js";

export type ValidatorSigningIntent = "block-proposal" | "block-attestation" | "round-skip";

export interface ValidatorSigner {
  readonly publicKey: string;
  signCanonical(payload: unknown, intent: ValidatorSigningIntent): Promise<string>;
}

export class LocalValidatorSigner implements ValidatorSigner {
  readonly publicKey: string;

  constructor(private readonly privateKey: string) {
    this.publicKey = publicKeyFromPrivate(privateKey);
  }

  async signCanonical(payload: unknown, _intent: ValidatorSigningIntent): Promise<string> {
    return signCanonical(payload, this.privateKey);
  }
}

/**
 * Provider-neutral remote signer client. The validator secret never enters the
 * node process. Production signer services should enforce the supplied intent
 * and their own anti-double-sign policy before releasing a signature.
 */
export class RemoteValidatorSigner implements ValidatorSigner {
  readonly publicKey: string;
  private readonly endpoint: URL;

  constructor(endpoint: string, publicKey: string, private readonly timeoutMs = 3_000) {
    assertHex(publicKey, 64, "validator signer public key");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new Error("Invalid validator signer timeout");
    }
    this.endpoint = validateRemoteSignerEndpoint(endpoint);
    this.publicKey = publicKey;
  }

  async signCanonical(payload: unknown, intent: ValidatorSigningIntent): Promise<string> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, intent, payload }),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error"
    });
    if (!response.ok) throw new Error(`Remote validator signer returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 1_024) throw new Error("Remote validator signer response is too large");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > 1_024) throw new Error("Remote validator signer response is too large");
    let value: unknown;
    try { value = JSON.parse(body); } catch { throw new Error("Remote validator signer returned invalid JSON"); }
    assertPlainRecord(value, "validator signer response");
    assertExactKeys(value, ["signature"], "validator signer response");
    if (typeof value.signature !== "string") throw new Error("Remote validator signer returned invalid signature");
    assertHex(value.signature, 64, "validator signer signature");
    if (!verifyCanonical(payload, value.signature, this.publicKey)) {
      throw new Error("Remote validator signer returned a signature for the wrong key or payload");
    }
    return value.signature;
  }
}

export async function signWithValidator(
  signer: ValidatorSigner,
  payload: unknown,
  intent: ValidatorSigningIntent
): Promise<string> {
  const signature = await signer.signCanonical(payload, intent);
  assertHex(signature, 64, "validator signature");
  if (!verifyCanonical(payload, signature, signer.publicKey)) {
    throw new Error("Validator signer returned a signature for the wrong key or payload");
  }
  return signature;
}

function validateRemoteSignerEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("Validator signer URL contains forbidden components");
  if (url.protocol === "https:") return url;
  if (url.protocol !== "http:") throw new Error("Validator signer URL must use HTTPS or loopback HTTP");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
  if (!loopback) throw new Error("Plain HTTP validator signer is allowed only on loopback");
  return url;
}

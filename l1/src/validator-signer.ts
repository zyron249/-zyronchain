import { isIP } from "node:net";

import { assertExactKeys, assertPlainRecord } from "./transaction.js";
import { assertHex } from "./codec.js";
import {
  publicKeyFromPrivate,
  signCanonical,
  signCanonicalDomain,
  verifyCanonical,
  verifyCanonicalDomain
} from "./crypto.js";

export type ValidatorSigningIntent = "block-proposal" | "block-attestation" | "round-skip";

export interface ValidatorSigner {
  readonly publicKey: string;
  signCanonical(payload: unknown, intent: ValidatorSigningIntent, protocolVersion?: number): Promise<string>;
}

export class LocalValidatorSigner implements ValidatorSigner {
  readonly publicKey: string;

  constructor(private readonly privateKey: string) {
    this.publicKey = publicKeyFromPrivate(privateKey);
  }

  async signCanonical(payload: unknown, intent: ValidatorSigningIntent, protocolVersion = 1): Promise<string> {
    return protocolVersion >= 3
      ? signCanonicalDomain(validatorSigningDomain(intent), payload, this.privateKey)
      : signCanonical(payload, this.privateKey);
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

  constructor(
    endpoint: string,
    publicKey: string,
    private readonly bearerToken?: string,
    private readonly timeoutMs = 3_000
  ) {
    assertHex(publicKey, 64, "validator signer public key");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new Error("Invalid validator signer timeout");
    }
    if (bearerToken !== undefined &&
        (bearerToken.length < 32 || bearerToken.length > 512 || !/^[\\x21-\\x7e]+$/.test(bearerToken))) {
      throw new Error("Invalid validator signer bearer token");
    }
    this.endpoint = validateRemoteSignerEndpoint(endpoint);
    this.publicKey = publicKey;
  }

  async signCanonical(payload: unknown, intent: ValidatorSigningIntent, protocolVersion = 1): Promise<string> {
    const domain = protocolVersion >= 3 ? validatorSigningDomain(intent) : undefined;
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {})
      },
      body: JSON.stringify(domain
        ? { version: 2, intent, domain, payload }
        : { version: 1, intent, payload }),
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
    const valid = domain
      ? verifyCanonicalDomain(domain, payload, value.signature, this.publicKey)
      : verifyCanonical(payload, value.signature, this.publicKey);
    if (!valid) {
      throw new Error("Remote validator signer returned a signature for the wrong key or payload");
    }
    return value.signature;
  }
}

export async function signWithValidator(
  signer: ValidatorSigner,
  payload: unknown,
  intent: ValidatorSigningIntent,
  protocolVersion = 1
): Promise<string> {
  const signature = await signer.signCanonical(payload, intent, protocolVersion);
  assertHex(signature, 64, "validator signature");
  const valid = protocolVersion >= 3
    ? verifyCanonicalDomain(validatorSigningDomain(intent), payload, signature, signer.publicKey)
    : verifyCanonical(payload, signature, signer.publicKey);
  if (!valid) {
    throw new Error("Validator signer returned a signature for the wrong key or payload");
  }
  return signature;
}

export function validatorSigningDomain(intent: ValidatorSigningIntent): string {
  switch (intent) {
    case "block-proposal": return "zyronchain/block-proposal/v1";
    case "block-attestation": return "zyronchain/finality-attestation/v1";
    case "round-skip": return "zyronchain/round-skip/v1";
  }
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

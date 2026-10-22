import { isIP } from "node:net";
import { assertExactKeys, assertPlainRecord } from "./transaction.js";
import { assertHex } from "./codec.js";
import { publicKeyFromPrivate, signCanonical, signCanonicalDomain, verifyCanonical, verifyCanonicalDomain } from "./crypto.js";
export const CONSENSUS_V6_SIGNING_INTENTS = new Set([
    "consensus-proposal", "prepare-vote", "commit-vote", "round-timeout"
]);
export class LocalValidatorSigner {
    privateKey;
    publicKey;
    constructor(privateKey) {
        this.privateKey = privateKey;
        this.publicKey = publicKeyFromPrivate(privateKey);
    }
    async signCanonical(payload, intent, protocolVersion = 1, _context) {
        assertIntentProtocolVersion(intent, protocolVersion);
        return protocolVersion >= 3
            ? signCanonicalDomain(validatorSigningDomain(intent), payload, this.privateKey)
            : signCanonical(payload, this.privateKey);
    }
}
/**
 * Provider-neutral remote signer client. The validator secret never enters the
 * node process. Remote signer authentication is mandatory at this reusable
 * client boundary. Production signer services should enforce the supplied
 * intent and their own anti-double-sign policy before releasing a signature.
 */
export class RemoteValidatorSigner {
    timeoutMs;
    publicKey;
    endpoint;
    bearerToken;
    allowConsensusV6Intents;
    constructor(endpoint, publicKey, bearerToken, timeoutMs = 3_000, options = {}) {
        this.timeoutMs = timeoutMs;
        this.allowConsensusV6Intents = options.allowConsensusV6Intents === true;
        assertHex(publicKey, 64, "validator signer public key");
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
            throw new Error("Invalid validator signer timeout");
        }
        if (typeof bearerToken !== "string" ||
            bearerToken.length < 32 || bearerToken.length > 512 || !/^[\x21-\x7e]+$/.test(bearerToken)) {
            throw new Error("Invalid validator signer bearer token");
        }
        this.endpoint = validateRemoteSignerEndpoint(endpoint);
        this.publicKey = publicKey;
        this.bearerToken = bearerToken;
    }
    async signCanonical(payload, intent, protocolVersion = 1, context) {
        assertIntentProtocolVersion(intent, protocolVersion);
        if (CONSENSUS_V6_SIGNING_INTENTS.has(intent) && !this.allowConsensusV6Intents) {
            throw new Error("Remote validator signer is not enabled for protocol v6 consensus intents");
        }
        const domain = protocolVersion >= 3 ? validatorSigningDomain(intent) : undefined;
        const response = await fetch(this.endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "accept": "application/json",
                authorization: `Bearer ${this.bearerToken}`
            },
            body: JSON.stringify(domain
                ? { version: 2, intent, domain, payload, ...(context === undefined ? {} : { context }) }
                : { version: 1, intent, payload }),
            signal: AbortSignal.timeout(this.timeoutMs),
            redirect: "error"
        });
        if (!response.ok)
            throw new Error(`Remote validator signer returned HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") ?? "";
        if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
            throw new Error("Remote validator signer must return application/json");
        }
        const contentLength = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(contentLength) && contentLength > 1_024)
            throw new Error("Remote validator signer response is too large");
        const body = await readBoundedResponseBody(response, 1_024);
        let value;
        try {
            value = JSON.parse(body);
        }
        catch {
            throw new Error("Remote validator signer returned invalid JSON");
        }
        assertPlainRecord(value, "validator signer response");
        assertExactKeys(value, ["signature"], "validator signer response");
        if (typeof value.signature !== "string")
            throw new Error("Remote validator signer returned invalid signature");
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
export async function signWithValidator(signer, payload, intent, protocolVersion = 1, context) {
    assertIntentProtocolVersion(intent, protocolVersion);
    const signature = await signer.signCanonical(payload, intent, protocolVersion, context);
    assertHex(signature, 64, "validator signature");
    const valid = protocolVersion >= 3
        ? verifyCanonicalDomain(validatorSigningDomain(intent), payload, signature, signer.publicKey)
        : verifyCanonical(payload, signature, signer.publicKey);
    if (!valid) {
        throw new Error("Validator signer returned a signature for the wrong key or payload");
    }
    return signature;
}
// v6 consensus messages exist only under protocol v6 and are always
// domain-separated; signing one under a legacy (undomained) scheme would let
// it collide with legacy payloads, so it is refused outright.
function assertIntentProtocolVersion(intent, protocolVersion) {
    if (CONSENSUS_V6_SIGNING_INTENTS.has(intent) && protocolVersion !== 6) {
        throw new Error("Protocol v6 consensus intents require protocol version 6");
    }
}
export function validatorSigningDomain(intent) {
    switch (intent) {
        case "block-proposal": return "zyronchain/block-proposal/v1";
        case "block-attestation": return "zyronchain/finality-attestation/v1";
        case "round-skip": return "zyronchain/round-skip/v1";
        case "consensus-proposal": return "zyronchain/consensus-proposal/v1";
        case "prepare-vote": return "zyronchain/prepare-vote/v1";
        case "commit-vote": return "zyronchain/commit-vote/v1";
        case "round-timeout": return "zyronchain/round-timeout/v1";
    }
}
function validateRemoteSignerEndpoint(value) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash)
        throw new Error("Validator signer URL contains forbidden components");
    if (url.protocol === "https:")
        return url;
    if (url.protocol !== "http:")
        throw new Error("Validator signer URL must use HTTPS or loopback HTTP");
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = hostname === "localhost" || hostname === "::1" ||
        (isIP(hostname) === 4 && hostname.startsWith("127."));
    if (!loopback)
        throw new Error("Plain HTTP validator signer is allowed only on loopback");
    return url;
}
async function readBoundedResponseBody(response, maxBytes) {
    if (!response.body)
        throw new Error("Remote validator signer returned an empty body");
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new Error("Remote validator signer response is too large");
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

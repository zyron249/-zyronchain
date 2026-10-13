import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { blockHash, expectedValidator } from "./block.js";
import { assertHex } from "./codec.js";
import {
  CONSENSUS_V6_PROTOCOL_VERSION,
  proposalDigest,
  proposalPayload,
  timeoutDigest,
  timeoutPayload,
  V6_MAX_ROUND,
  validatePrepareQC,
  votePayload,
  ZERO_HASH,
  type PrepareQC,
  type V6ProposalPayload,
  type V6TimeoutPayload
} from "./consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate, signCanonical, signCanonicalDomain } from "./crypto.js";
import { SigningJournal } from "./storage.js";
import { assertExactKeys, assertPlainRecord } from "./transaction.js";
import type { BlockHeader, Validator } from "./types.js";
import { CONSENSUS_V6_SIGNING_INTENTS, validatorSigningDomain, type ValidatorSigningIntent } from "./validator-signer.js";

/**
 * Reference remote validator signer (backlog P0-09).
 *
 * The signer owns the validator key and its own durable signing journal
 * (the same journal v2 format and rules as the node, F01 design §6 and §9),
 * so the custody boundary itself refuses double-signs and lock violations,
 * even when the node that calls it is compromised or buggy:
 *
 * - one value per (height, round, step), identical requests re-sign
 *   identically (deterministic signatures), across restarts;
 * - prepare votes obey SAFE-VOTE against the signer's own lock; a lock is
 *   released only by a PrepareQC the signer verifies itself (§4.4);
 * - commit votes require a verified PrepareQC for exactly (H, r, block) and
 *   persist lock + commit in one fsynced append before the signature (§4.1, §9.1);
 * - after timeout(H, r) nothing more is signed in round <= r (§6.2-2), and a
 *   new timeout is refused once a later round was voted or timed out;
 * - proposals and v6 block proposals only for the round leader; an
 *   unjustified proposal only for the signer's own fresh block (§6.2-6);
 * - never legacy and v6 signatures at one height (§6.2-7).
 *
 * Protocol v6 intents are refused unless `allowConsensusV6Intents` is set,
 * and enabling them requires the validator set used to verify certificates.
 * Legacy (v1-v5) intents keep the previous behaviour: round skips are
 * journaled; legacy attestations and block proposals carry no round in their
 * payload, so the node journal remains their equivocation guard.
 *
 * This is a reference implementation for tests, rehearsals and operators who
 * build their own signer. It is not an HSM and does not establish production
 * custody.
 */
export interface ReferenceRemoteSignerOptions {
  privateKey: string;
  dataDir: string;
  chainId: string;
  /** Off by default. */
  allowConsensusV6Intents?: boolean;
  /**
   * Validator set at the heights being signed (address + public key), used to
   * verify PrepareQCs. Required when v6 is enabled; must contain this key.
   * Operators must update it (and restart the signer) when the on-chain
   * validator set changes; a stale set fails closed for unknown signers.
   */
  validators?: Validator[];
}

export interface RemoteSigningResult {
  signature: string;
}

export class RemoteSignerRefusal extends Error {}

const MAX_REQUEST_BYTES = 256 * 1024;
const HEX32 = /^[0-9a-f]{64}$/;

export class ReferenceRemoteSigner {
  readonly publicKey: string;
  readonly address: string;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly privateKey: string,
    private readonly journal: SigningJournal,
    private readonly chainId: string,
    private readonly allowV6: boolean,
    private readonly validators: Validator[] | undefined
  ) {
    this.publicKey = publicKeyFromPrivate(privateKey);
    this.address = addressFromPublicKey(this.publicKey);
  }

  static async open(options: ReferenceRemoteSignerOptions): Promise<ReferenceRemoteSigner> {
    assertHex(options.privateKey, 32, "remote signer private key");
    if (typeof options.chainId !== "string" || !/^[a-z0-9-]{3,64}$/.test(options.chainId)) throw new Error("Invalid remote signer chain ID");
    const allowV6 = options.allowConsensusV6Intents === true;
    let validators: Validator[] | undefined;
    if (allowV6) {
      if (!Array.isArray(options.validators) || options.validators.length === 0) {
        throw new Error("Protocol v6 remote signing requires the validator set used to verify certificates");
      }
      validators = options.validators.map((validator) => {
        assertPlainRecord(validator, "remote signer validator");
        assertExactKeys(validator, ["address", "publicKey"], "remote signer validator");
        assertHex(validator.publicKey, 64, "remote signer validator public key");
        if (addressFromPublicKey(validator.publicKey) !== validator.address) throw new Error("Remote signer validator address mismatch");
        return { address: validator.address, publicKey: validator.publicKey };
      });
      if (new Set(validators.map((validator) => validator.address)).size !== validators.length) {
        throw new Error("Duplicate remote signer validator");
      }
      const own = publicKeyFromPrivate(options.privateKey);
      if (!validators.some((validator) => validator.publicKey === own)) {
        throw new Error("Remote signer key is not a member of the configured validator set");
      }
    }
    const journal = await SigningJournal.open(options.dataDir);
    return new ReferenceRemoteSigner(options.privateKey, journal, options.chainId, allowV6, validators);
  }

  close(): void {
    this.journal.close();
  }

  /** Validate, journal and sign one request. Requests are serialized. */
  sign(request: unknown): Promise<RemoteSigningResult> {
    const run = this.queue.then(() => this.signLocked(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async signLocked(value: unknown): Promise<RemoteSigningResult> {
    assertPlainRecord(value, "remote signing request");
    const version = value.version;
    if (version !== 1 && version !== 2) throw new RemoteSignerRefusal("Unsupported remote signing request version");
    const hasContext = Object.prototype.hasOwnProperty.call(value, "context");
    assertExactKeys(value, version === 1
      ? ["version", "intent", "payload"]
      : ["version", "intent", "domain", "payload", ...(hasContext ? ["context"] : [])], "remote signing request");
    const intent = value.intent as ValidatorSigningIntent;
    if (typeof intent !== "string" || !KNOWN_INTENTS.has(intent)) throw new RemoteSignerRefusal("Unknown signing intent");
    const payload = value.payload;
    const context = hasContext ? value.context : undefined;

    if (version === 1) {
      if (CONSENSUS_V6_SIGNING_INTENTS.has(intent)) throw new RemoteSignerRefusal("Protocol v6 intents require request version 2");
      if (hasContext) throw new RemoteSignerRefusal("Legacy signing requests carry no context");
      await this.legacyGuard(intent, payload);
      return { signature: signCanonical(payload, this.privateKey) };
    }
    const domain = validatorSigningDomain(intent);
    if (value.domain !== domain) throw new RemoteSignerRefusal("Signing domain does not match the intent");

    const v6 = CONSENSUS_V6_SIGNING_INTENTS.has(intent) ||
      (intent === "block-proposal" && isRecord(payload) && payload.version === CONSENSUS_V6_PROTOCOL_VERSION);
    if (!v6) {
      if (hasContext) throw new RemoteSignerRefusal("Legacy signing requests carry no context");
      await this.legacyGuard(intent, payload);
      return { signature: signCanonicalDomain(domain, payload, this.privateKey) };
    }
    if (!this.allowV6) throw new RemoteSignerRefusal("Remote signer is not enabled for protocol v6 consensus intents");
    const signed = await this.v6Reserve(intent, payload, context);
    return { signature: signCanonicalDomain(domain, signed, this.privateKey) };
  }

  /** Legacy intents: never at a height with v6 rows; round skips are journaled. */
  private async legacyGuard(intent: ValidatorSigningIntent, payload: unknown): Promise<void> {
    assertPlainRecord(payload, "legacy signing payload");
    if (payload.chainId !== this.chainId) throw new RemoteSignerRefusal("Signing payload is for another chain");
    const height = payload.height;
    if (!Number.isSafeInteger(height) || (height as number) < 1) throw new RemoteSignerRefusal("Invalid signing height");
    if (this.journal.hasV6Rows(height as number)) {
      throw new RemoteSignerRefusal("Legacy validator action refused: protocol v6 journal rows exist at this height");
    }
    if (intent === "round-skip") {
      const round = payload.round;
      const previousHash = payload.previousHash;
      if (payload.publicKey !== this.publicKey || payload.validator !== this.address) {
        throw new RemoteSignerRefusal("Round skip is not for this validator");
      }
      if (!Number.isSafeInteger(round) || (round as number) < 0 || typeof previousHash !== "string" || !HEX32.test(previousHash)) {
        throw new RemoteSignerRefusal("Invalid round skip payload");
      }
      await this.journal.reserveSkip(height as number, round as number, previousHash);
    } else {
      // block-proposal / block-attestation carry no round: persist a height
      // high-water marker before releasing the signature so a v6 action at
      // this height is refused, also after restart (round-4 PR974 finding).
      await this.journal.reserveLegacyHeight(height as number);
    }
  }

  private requireValidators(): Validator[] {
    if (!this.validators) throw new RemoteSignerRefusal("Protocol v6 remote signing requires a validator set");
    return this.validators;
  }

  private slot(payload: Record<string, unknown>): { height: number; round: number } {
    if (payload.chainId !== this.chainId) throw new RemoteSignerRefusal("Signing payload is for another chain");
    const { height, round } = payload;
    if (!Number.isSafeInteger(height) || (height as number) < 1 ||
        !Number.isSafeInteger(round) || (round as number) < 0 || (round as number) > V6_MAX_ROUND) {
      throw new RemoteSignerRefusal("Invalid v6 signing slot");
    }
    return { height: height as number, round: round as number };
  }

  private assertLeader(height: number, round: number): void {
    if (expectedValidator(this.requireValidators(), height, round).publicKey !== this.publicKey) {
      throw new RemoteSignerRefusal("Protocol v6 proposal refused: this validator is not the round leader");
    }
  }

  private verifyQC(qc: unknown, height: number, round: number, hash: string, label: string): PrepareQC {
    validatePrepareQC(qc, this.requireValidators(), this.chainId, height);
    if (qc.round !== round || qc.blockHash !== hash) {
      throw new RemoteSignerRefusal(`${label}: Prepare QC does not match the signed round and block`);
    }
    return qc;
  }

  /** Journal the v6 action (all rule checks happen here, before any signature) and return the exact payload to sign. */
  private async v6Reserve(intent: ValidatorSigningIntent, payload: unknown, context: unknown): Promise<unknown> {
    assertPlainRecord(payload, "v6 signing payload");
    const journal = this.journal;
    switch (intent) {
      case "block-proposal": {
        if (context !== undefined) throw new RemoteSignerRefusal("Block proposal requests carry no context");
        const header = payload as unknown as BlockHeader;
        assertExactKeys(payload, ["version", "chainId", "height", "round", "previousHash", "timestampMs", "transactionRoot", "stateRoot", "proposer"], "v6 block header");
        const { height, round } = this.slot(payload);
        if (header.proposer !== this.address) throw new RemoteSignerRefusal("Protocol v6 block proposal refused: proposer is not this validator");
        this.assertLeader(height, round);
        let hash: string;
        try { hash = blockHash(header); } catch { throw new RemoteSignerRefusal("Invalid v6 block header"); }
        await journal.reserveV6(height, round, "block-proposal", hash);
        return payload;
      }
      case "consensus-proposal": {
        assertExactKeys(payload, ["chainId", "height", "round", "blockHash", "justifyRound"], "v6 proposal");
        const { height, round } = this.slot(payload);
        const proposal = payload as unknown as V6ProposalPayload;
        if (typeof proposal.blockHash !== "string" || !HEX32.test(proposal.blockHash) ||
            !Number.isSafeInteger(proposal.justifyRound) || proposal.justifyRound < -1 || proposal.justifyRound >= round) {
          throw new RemoteSignerRefusal("Invalid v6 proposal payload");
        }
        const justify = contextField(context, "justify");
        this.assertLeader(height, round);
        if (proposal.justifyRound === -1) {
          if (justify !== null) throw new RemoteSignerRefusal("Unjustified proposal must not carry a justify QC");
          if (journal.v6Row(height, round, "block-proposal") !== proposal.blockHash) {
            throw new RemoteSignerRefusal("Unjustified v6 proposal must carry this leader's own fresh block");
          }
        } else {
          if (justify === null) throw new RemoteSignerRefusal("Justified v6 proposal requires its justify QC");
          this.verifyQC(justify, height, proposal.justifyRound, proposal.blockHash, "Proposal justify");
        }
        await journal.reserveV6(height, round, "proposal", proposalDigest(proposal));
        return proposalPayload(proposal);
      }
      case "prepare-vote": {
        assertExactKeys(payload, ["chainId", "height", "round", "blockHash"], "v6 prepare vote");
        const { height, round } = this.slot(payload);
        const hash = payload.blockHash;
        if (typeof hash !== "string" || !HEX32.test(hash)) throw new RemoteSignerRefusal("Invalid v6 vote block hash");
        const justify = contextField(context, "justify");
        // Only a QC the signer verifies itself can unlock (§4.4); a node-supplied
        // justify round on its own is never trusted.
        let justifyRound = -1;
        if (justify !== null) {
          validatePrepareQC(justify, this.requireValidators(), this.chainId, height);
          if (justify.blockHash !== hash || justify.round >= round) {
            throw new RemoteSignerRefusal("Protocol v6 prepare refused: justify QC is not for this block at a lower round");
          }
          justifyRound = justify.round;
        }
        await journal.reserveV6Prepare(height, round, hash, justifyRound);
        return votePayload(this.chainId, height, round, hash);
      }
      case "commit-vote": {
        assertExactKeys(payload, ["chainId", "height", "round", "blockHash"], "v6 commit vote");
        const { height, round } = this.slot(payload);
        const hash = payload.blockHash;
        if (typeof hash !== "string" || !HEX32.test(hash)) throw new RemoteSignerRefusal("Invalid v6 vote block hash");
        const qc = contextField(context, "qc");
        if (qc === null) throw new RemoteSignerRefusal("Protocol v6 commit refused: a lock requires the Prepare QC evidence");
        this.verifyQC(qc, height, round, hash, "Commit");
        await journal.reserveV6Commit(height, round, hash);
        return votePayload(this.chainId, height, round, hash);
      }
      case "round-timeout": {
        assertExactKeys(payload, ["chainId", "height", "round", "highQCRound", "highQCHash"], "v6 timeout");
        const { height, round } = this.slot(payload);
        const timeout = payload as unknown as V6TimeoutPayload;
        if (!Number.isSafeInteger(timeout.highQCRound) || timeout.highQCRound < -1 || timeout.highQCRound > round ||
            typeof timeout.highQCHash !== "string" || !HEX32.test(timeout.highQCHash)) {
          throw new RemoteSignerRefusal("Invalid v6 timeout highQC report (needs -1 <= highQCRound <= round)");
        }
        const highQC = contextField(context, "highQC");
        if (timeout.highQCRound === -1) {
          if (timeout.highQCHash !== ZERO_HASH || highQC !== null) throw new RemoteSignerRefusal("Invalid v6 timeout highQC report");
        } else {
          if (highQC === null) throw new RemoteSignerRefusal("v6 timeout reports a highQC without the QC evidence");
          this.verifyQC(highQC, height, timeout.highQCRound, timeout.highQCHash, "Timeout highQC");
        }
        const digest = timeoutDigest(timeout);
        if (journal.v6Row(height, round, "timeout") === undefined) {
          const rounds = journal.v6Rounds(height);
          if (rounds.maxVoteRound > round || rounds.maxTimeoutRound > round) {
            throw new RemoteSignerRefusal("Protocol v6 timeout refused: a later round was already voted or timed out");
          }
        }
        await journal.reserveV6(height, round, "timeout", digest);
        return timeoutPayload(timeout);
      }
      default:
        throw new RemoteSignerRefusal("Intent is not a protocol v6 signing intent");
    }
  }
}

const KNOWN_INTENTS: ReadonlySet<string> = new Set<ValidatorSigningIntent>([
  "block-proposal", "block-attestation", "round-skip", "consensus-proposal", "prepare-vote", "commit-vote", "round-timeout"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Exact single-key context `{ [name]: value | null }`; returns the value. */
function contextField(context: unknown, name: string): unknown {
  if (context === undefined) throw new RemoteSignerRefusal(`v6 signing request requires context.${name}`);
  assertPlainRecord(context, "v6 signing context");
  assertExactKeys(context, [name], "v6 signing context");
  return context[name] ?? null;
}

export interface ReferenceRemoteSignerServer {
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

/**
 * Minimal HTTP front end compatible with `RemoteValidatorSigner`: POST JSON,
 * mandatory bearer token (constant-time compare), bounded body, JSON
 * `{ signature }` on success, 401 on bad credentials, 400 on malformed
 * requests and 409 when the signer refuses (journal rule, lock, evidence).
 * Bind it to loopback or put it behind TLS; it never logs payloads or tokens.
 */
export async function startReferenceRemoteSignerServer(options: {
  signer: ReferenceRemoteSigner;
  bearerToken: string;
  host?: string;
  port?: number;
}): Promise<ReferenceRemoteSignerServer> {
  const token = options.bearerToken;
  if (typeof token !== "string" || token.length < 32 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("Invalid remote signer bearer token");
  }
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const server = createServer((req, res) => {
    void handle(options.signer, expected, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}/sign`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function handle(signer: ReferenceRemoteSigner, expected: Buffer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
    res.end(text);
  };
  try {
    const provided = Buffer.from(req.headers.authorization ?? "", "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      req.resume();
      reply(401, { error: "unauthorized" });
      return;
    }
    if (req.method !== "POST" || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
      req.resume();
      reply(400, { error: "bad request" });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).byteLength;
      if (total > MAX_REQUEST_BYTES) {
        reply(413, { error: "request too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      reply(400, { error: "invalid json" });
      return;
    }
    try {
      reply(200, await signer.sign(value));
    } catch (error) {
      // Refusals are expected protocol outcomes; the reason stays server-side
      // so a caller cannot probe journal contents beyond refused/accepted.
      reply(409, { error: error instanceof Error && /persistence|restart/i.test(error.message) ? "signer unavailable" : "refused" });
    }
  } catch {
    if (!res.headersSent) reply(500, { error: "internal error" });
  }
}

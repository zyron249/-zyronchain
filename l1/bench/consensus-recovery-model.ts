// EXPERIMENT ONLY. Not imported by the node, signer, RPC or light client.
// Single-height, fixed-membership authenticated prepare/commit model.
// Persistence is an injected synchronous model boundary, NOT disk durability.
import { canonicalJson } from "../src/codec.js";
import { publicKeyFromPrivate, signCanonicalDomain, verifyCanonicalDomain } from "../src/crypto.js";
import { validatorQuorumSize } from "../src/block.js";

export interface ModelContext {
  chainId: string;
  genesisHash: string;
  height: number;
  previousHash: string;
}
export interface Vote {
  phase: "prepare" | "commit";
  view: number;
  value: string;
  signer: number;
  signature: string;
}
export interface Change {
  view: number;
  prepared: Vote[] | null;
  signer: number;
  signature: string;
}
export interface Proposal {
  view: number;
  value: string;
  changes: Change[];
  signer: number;
  signature: string;
}
export interface ModelState {
  view: number;
  prepared: Vote[] | null;
  ownPrepare: string | null;
  ownCommit: string | null;
  ownProposal: Omit<Proposal, "signature"> | null;
  ownChange: Omit<Change, "signature"> | null;
  decided: string | null;
}

// Distinct from every production signing domain. Even valid model signatures
// cannot be used as production proposals, attestations or round-skip votes.
export const MODEL_DOMAIN = "zyronchain/recovery-model-only/v1";
export class ModelVerifier {
  readonly keys: readonly string[];
  readonly context: Readonly<ModelContext>;
  constructor(context: ModelContext, keys: readonly string[]) {
    if (keys.length < 2 || keys.length > 16 || new Set(keys).size !== keys.length) throw new Error("Invalid model membership");
    this.keys = Object.freeze([...keys]);
    this.context = Object.freeze({ ...context });
  }
  payload(kind: string, message: unknown): unknown {
    return { context: this.context, members: this.keys, kind, message };
  }
  sign(kind: string, message: unknown, privateKey: string): string {
    return signCanonicalDomain(MODEL_DOMAIN, this.payload(kind, message), privateKey);
  }
  verify(kind: string, value: { signer: number; signature: string }): void {
    const { signature, ...message } = value;
    if (!Number.isSafeInteger(value.signer) || !this.keys[value.signer] ||
        !verifyCanonicalDomain(MODEL_DOMAIN, this.payload(kind, message), signature, this.keys[value.signer]!)) {
      throw new Error("Invalid model signature");
    }
  }
  certificate(votes: Vote[], phase: Vote["phase"]): { view: number; value: string } {
    if (votes.length < validatorQuorumSize(this.keys.length) || votes.length > this.keys.length) throw new Error("Model quorum missing");
    const first = votes[0]!;
    validView(first.view);
    validValue(first.value);
    const seen = new Set<number>();
    for (const vote of votes) {
      if (vote.phase !== phase || vote.view !== first.view || vote.value !== first.value) throw new Error("Mixed model certificate");
      if (seen.has(vote.signer)) throw new Error("Duplicate model voter");
      seen.add(vote.signer);
      this.verify(phase, vote);
    }
    return { view: first.view, value: first.value };
  }
  highest(changes: Change[], view: number): Vote[] | null {
    validView(view);
    if (view === 0) {
      if (changes.length) throw new Error("Initial view contains changes");
      return null;
    }
    if (changes.length < validatorQuorumSize(this.keys.length) || changes.length > this.keys.length) throw new Error("View-change quorum missing");
    const seen = new Set<number>();
    let highest: Vote[] | null = null;
    for (const change of changes) {
      if (change.view !== view || seen.has(change.signer)) throw new Error("Invalid or duplicate view change");
      seen.add(change.signer);
      this.verify("change", change);
      if (change.prepared !== null) {
        const prepared = this.certificate(change.prepared, "prepare");
        if (prepared.view >= view) throw new Error("Prepared proof must precede new view");
        if (highest && highest[0]!.view === prepared.view && highest[0]!.value !== prepared.value) throw new Error("Conflicting prepared proofs");
        if (!highest || highest[0]!.view < prepared.view) highest = change.prepared;
      }
    }
    return highest;
  }
  proposal(proposal: Proposal): Vote[] | null {
    validView(proposal.view);
    validValue(proposal.value);
    if (proposal.signer !== proposal.view % this.keys.length) throw new Error("Wrong model proposer");
    this.verify("proposal", proposal);
    const highest = this.highest(proposal.changes, proposal.view);
    if (highest && proposal.value !== highest[0]!.value) throw new Error("Proposal discards prepared value");
    return highest;
  }
}

export class RecoveryReplica {
  private state: ModelState;
  private faulted = false;
  readonly id: number;
  constructor(
    readonly verifier: ModelVerifier,
    private readonly key: string,
    private readonly persist: (state: ModelState) => void,
    recovered?: ModelState
  ) {
    this.id = verifier.keys.indexOf(publicKeyFromPrivate(key));
    if (this.id < 0) throw new Error("Unknown model signer");
    // Recovery input is trusted simulator storage, not an untrusted wire/file parser.
    this.state = structuredClone(recovered ?? { view: 0, prepared: null, ownPrepare: null,
      ownCommit: null, ownProposal: null, ownChange: null, decided: null });
  }
  snapshot(): ModelState { return structuredClone(this.state); }
  private active(): void {
    if (this.faulted) throw new Error("Model persistence fault; restart required");
    if (this.state.decided !== null) throw new Error("Model height already decided");
  }
  private save(next: ModelState): void {
    try { this.persist(structuredClone(next)); }
    catch (error) { this.faulted = true; throw new Error("Model persistence fault; restart required", { cause: error }); }
    this.state = structuredClone(next);
  }
  private advance(view: number): ModelState {
    validView(view);
    if (view < this.state.view) throw new Error("Stale model view");
    return view === this.state.view ? this.snapshot() : {
      ...this.snapshot(), view, ownPrepare: null, ownCommit: null, ownProposal: null, ownChange: null
    };
  }
  propose(value: string, changes: Change[] = []): Proposal {
    this.active();
    const unsigned = { view: this.state.view, value, changes: structuredClone(changes), signer: this.id };
    // Validate without releasing a signature. Own proposal is also write-ahead.
    validValue(value);
    if (this.id !== unsigned.view % this.verifier.keys.length) throw new Error("Wrong model proposer");
    const highest = this.verifier.highest(changes, unsigned.view);
    if (highest && highest[0]!.value !== value) throw new Error("Proposal discards prepared value");
    if (this.state.ownProposal && canonicalJson(this.state.ownProposal) !== canonicalJson(unsigned)) throw new Error("Conflicting model proposal");
    this.save({ ...this.snapshot(), ownProposal: unsigned });
    return { ...unsigned, signature: this.verifier.sign("proposal", unsigned, this.key) };
  }
  prepare(proposal: Proposal): Vote {
    this.active();
    const highest = this.verifier.proposal(proposal);
    const next = this.advance(proposal.view);
    if (next.ownPrepare !== null && next.ownPrepare !== proposal.value) throw new Error("Conflicting model prepare");
    next.ownPrepare = proposal.value;
    if (highest && (!next.prepared || next.prepared[0]!.view < highest[0]!.view)) next.prepared = structuredClone(highest);
    this.save(next);
    const vote = { phase: "prepare" as const, view: proposal.view, value: proposal.value, signer: this.id };
    return { ...vote, signature: this.verifier.sign("prepare", vote, this.key) };
  }
  commit(prepares: Vote[]): Vote {
    this.active();
    const certificate = this.verifier.certificate(prepares, "prepare");
    if (certificate.view !== this.state.view) throw new Error("Stale or future commit view");
    if (this.state.ownPrepare !== certificate.value) throw new Error("Commit requires own validated prepare");
    if (this.state.ownCommit !== null && this.state.ownCommit !== certificate.value) throw new Error("Conflicting model commit");
    this.save({ ...this.snapshot(), prepared: structuredClone(prepares), ownCommit: certificate.value });
    const vote = { phase: "commit" as const, ...certificate, signer: this.id };
    return { ...vote, signature: this.verifier.sign("commit", vote, this.key) };
  }
  changeView(view: number): Change {
    this.active();
    if (view === this.state.view && this.state.ownChange) {
      const saved = structuredClone(this.state.ownChange);
      return { ...saved, signature: this.verifier.sign("change", saved, this.key) };
    }
    if (view <= this.state.view) throw new Error("View change must advance");
    const next = this.advance(view);
    const unsigned = { view, prepared: structuredClone(next.prepared), signer: this.id };
    next.ownChange = unsigned;
    this.save(next);
    return { ...unsigned, signature: this.verifier.sign("change", unsigned, this.key) };
  }
  decide(commits: Vote[]): string {
    if (this.faulted) throw new Error("Model persistence fault; restart required");
    const { value } = this.verifier.certificate(commits, "commit");
    if (this.state.decided !== null && this.state.decided !== value) throw new Error("Conflicting model finality");
    this.save({ ...this.snapshot(), decided: value });
    return value;
  }
}

function validView(view: number): void {
  if (!Number.isSafeInteger(view) || view < 0) throw new Error("Invalid model view");
}
function validValue(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid model value");
}

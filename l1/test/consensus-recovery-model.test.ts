import assert from "node:assert/strict";
import test from "node:test";
import { publicKeyFromPrivate, verifyCanonicalDomain } from "../src/crypto.js";
import { validatorQuorumSize } from "../src/block.js";
import { ModelVerifier, RecoveryReplica } from "../bench/consensus-recovery-model.js";
import type { ModelState, Proposal, Vote } from "../bench/consensus-recovery-model.js";

const X = "11".repeat(32);
const Y = "22".repeat(32);
const context = { chainId: "zyron-recovery-experiment", genesisHash: "33".repeat(32), height: 3, previousHash: "44".repeat(32) };
function network(count: number) {
  const keys = Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(64, "0"));
  const verifier = new ModelVerifier(context, keys.map(publicKeyFromPrivate));
  const disk = new Map<number, ModelState>();
  const replicas = keys.map((key, id) => new RecoveryReplica(verifier, key, state => { disk.set(id, state); }));
  const restart = (id: number) => {
    replicas[id] = new RecoveryReplica(verifier, keys[id]!, state => { disk.set(id, state); }, disk.get(id));
  };
  return { keys, verifier, replicas, disk, restart, quorum: validatorQuorumSize(count) };
}
function finish(net: ReturnType<typeof network>, proposal: Proposal): Vote[] {
  const prepares = net.replicas.map(replica => replica.prepare(proposal)).slice(0, net.quorum);
  const commits = net.replicas.map(replica => replica.commit(prepares)).slice(0, net.quorum);
  for (const replica of net.replicas) assert.equal(replica.decide(commits), proposal.value);
  return commits;
}

for (const count of [2, 4, 7]) {
  test(`recovery model: ${count} validators heal a partial prepare across restart and view change`, () => {
    const net = network(count);
    const initial = net.replicas[0]!.propose(X);
    const partial = net.replicas.slice(0, Math.floor(count / 2)).map(r => r.prepare(initial));
    assert.throws(() => net.verifier.certificate(partial, "prepare"), /quorum missing/);
    for (let id = 0; id < count; id++) net.restart(id);
    const changes = net.replicas.map(r => r.changeView(1));
    // Unlike the production attest/skip rule, a non-final preparation need
    // not permanently forbid moving to a different value in a certified view.
    const proposal = net.replicas[1]!.propose(Y, changes);
    finish(net, proposal);
  });

  test(`recovery model: ${count} validators carry a prepared value across partial commit`, () => {
    const net = network(count);
    const initial = net.replicas[0]!.propose(X);
    const prepares = net.replicas.map(r => r.prepare(initial)).slice(0, net.quorum);
    const partial = [net.replicas[0]!.commit(prepares)];
    assert.throws(() => net.verifier.certificate(partial, "commit"), /quorum missing/);
    net.restart(0);
    const changes = net.replicas.map(r => r.changeView(1));
    assert.throws(() => net.replicas[1]!.propose(Y, changes), /discards prepared value/);
    finish(net, net.replicas[1]!.propose(X, changes));
  });
}

test('recovery model: every new-view quorum preserves a hidden final certificate with one Byzantine signer', () => {
  const net = network(4);
  const initial = net.replicas[0]!.propose(X);
  const prepares = net.replicas.map(r => r.prepare(initial)).slice(0, net.quorum);
  // A commit quorum exists but its aggregate has not yet reached any replica.
  const commits = net.replicas.slice(0, net.quorum).map(r => r.commit(prepares));
  const changes = net.replicas.map(r => r.changeView(1));
  // Byzantine replica 0 lies about its prepared state, with a real signature.
  const lie = { view: 1, prepared: null, signer: 0 };
  changes[0] = { ...lie, signature: net.verifier.sign('change', lie, net.keys[0]!) };
  for (let omitted = 0; omitted < 4; omitted++) {
    const quorum = changes.filter((_, i) => i !== omitted);
    assert.equal(net.verifier.highest(quorum, 1)![0]!.value, X);
    assert.throws(() => net.replicas[1]!.propose(Y, quorum), /discards prepared value/);
  }
  for (const replica of net.replicas) assert.equal(replica.decide(commits), X);
});

test('recovery model: recipients reject a signed new-view proposal discarding prepared evidence', () => {
  const net = network(4);
  const initial = net.replicas[0]!.propose(X);
  const prepares = net.replicas.map(r => r.prepare(initial)).slice(0, net.quorum);
  net.replicas[0]!.commit(prepares);
  const changes = net.replicas.map(r => r.changeView(1));
  const unsigned = { view: 1, value: Y, changes, signer: 1 };
  const malicious = { ...unsigned, signature: net.verifier.sign('proposal', unsigned, net.keys[1]!) };
  for (const replica of net.replicas) {
    assert.throws(() => replica.prepare(malicious), /discards prepared value/);
    assert.equal(replica.snapshot().ownPrepare, null);
  }
});

test('recovery model: higher-view promise rejects delayed old-view prepares and commits after restart', () => {
  const net = network(4);
  const initial = net.replicas[0]!.propose(X);
  const prepares = net.replicas.map(r => r.prepare(initial)).slice(0, net.quorum);
  net.replicas[0]!.changeView(1);
  net.restart(0);
  assert.throws(() => net.replicas[0]!.prepare(initial), /Stale model view/);
  assert.throws(() => net.replicas[0]!.commit(prepares), /Stale or future commit view/);
});

test('recovery model: equivocation is rejected before and after simulated restart', () => {
  const net = network(4);
  const initial = net.replicas[0]!.propose(X);
  net.replicas[1]!.prepare(initial);
  const { signature: _, ...unsigned } = { ...initial, value: Y };
  const evil = { ...unsigned, signature: net.verifier.sign('proposal', unsigned, net.keys[0]!) };
  assert.throws(() => net.replicas[0]!.propose(Y), /Conflicting model proposal/);
  assert.throws(() => net.replicas[1]!.prepare(evil), /Conflicting model prepare/);
  net.restart(1);
  assert.throws(() => net.replicas[1]!.prepare(evil), /Conflicting model prepare/);
});

test('recovery model: duplicate, cross-context, mixed-phase and tampered proofs fail', () => {
  const net = network(4);
  const initial = net.replicas[0]!.propose(X);
  const prepares = net.replicas.map(r => r.prepare(initial)).slice(0, net.quorum);
  assert.throws(() => net.verifier.certificate([prepares[0]!, prepares[0]!, prepares[1]!], 'prepare'), /Duplicate/);
  assert.throws(() => net.verifier.certificate(prepares, 'commit'), /Mixed/);
  assert.throws(() => net.verifier.certificate(prepares.map(v => ({ ...v, value: Y })), 'prepare'), /signature/);
  for (const changed of [{ ...context, height: 4 }, { ...context, chainId: 'other' },
    { ...context, genesisHash: Y }, { ...context, previousHash: Y }]) {
    const other = new ModelVerifier(changed, net.verifier.keys);
    assert.throws(() => other.certificate(prepares, 'prepare'), /signature/);
  }
  const changedSet = new ModelVerifier(context, [...net.verifier.keys].reverse());
  assert.throws(() => changedSet.certificate(prepares, 'prepare'), /signature/);
});

test('recovery model: new view needs distinct authenticated promises and an earlier prepared proof', () => {
  const net = network(4);
  const initial = net.replicas[0]!.propose(X);
  const prepares = net.replicas.map(r => r.prepare(initial)).slice(0, net.quorum);
  const changes = net.replicas.map(r => r.changeView(1));
  assert.throws(() => net.replicas[1]!.propose(Y, changes.slice(0, 2)), /quorum missing/);
  assert.throws(() => net.replicas[1]!.propose(Y, [changes[0]!, changes[0]!, changes[1]!]), /duplicate/);
  const future = prepares.map(v => {
    const unsigned = { phase: v.phase, view: 1, value: v.value, signer: v.signer };
    return { ...unsigned, signature: net.verifier.sign('prepare', unsigned, net.keys[v.signer]!) };
  });
  const invalid = { view: 1, prepared: future, signer: 0 };
  changes[0] = { ...invalid, signature: net.verifier.sign('change', invalid, net.keys[0]!) };
  assert.throws(() => net.verifier.highest(changes, 1), /must precede/);
});

for (const afterWrite of [false, true]) {
  test(`recovery model: persistence failure ${afterWrite ? 'after' : 'before'} simulated write releases no vote`, () => {
    const net = network(4);
    const proposal = net.replicas[0]!.propose(X);
    let saved: ModelState | undefined;
    const broken = new RecoveryReplica(net.verifier, net.keys[1]!, state => {
      if (afterWrite) saved = structuredClone(state);
      throw new Error('injected persistence fault');
    });
    assert.throws(() => broken.prepare(proposal), /persistence fault/);
    assert.throws(() => broken.changeView(1), /persistence fault/);
    const recovered = new RecoveryReplica(net.verifier, net.keys[1]!, state => { saved = state; }, saved);
    assert.equal(recovered.prepare(proposal).value, X);
    const { signature: _, ...unsigned } = { ...proposal, value: Y };
    assert.throws(() => recovered.prepare({ ...unsigned,
      signature: net.verifier.sign('proposal', unsigned, net.keys[0]!) }), /Conflicting/);
  });
}

test('recovery model: highest prepared proof survives multiple view changes and snapshot mutation', () => {
  const net = network(4);
  const proposal = net.replicas[0]!.propose(X);
  const prepares = net.replicas.map(r => r.prepare(proposal)).slice(0, net.quorum);
  net.replicas[0]!.commit(prepares);
  const snapshot = net.replicas[0]!.snapshot();
  snapshot.prepared = null;
  net.replicas.forEach(r => r.changeView(1));
  const changes = net.replicas.map(r => r.changeView(2));
  assert.equal(net.verifier.highest(changes, 2)![0]!.value, X);
  finish(net, net.replicas[2]!.propose(X, changes));
});

test('recovery model: experimental signatures cannot satisfy a production signing domain', () => {
  const net = network(2);
  const vote = net.replicas[0]!.prepare(net.replicas[0]!.propose(X));
  const { signature, ...message } = vote;
  assert.equal(verifyCanonicalDomain('zyronchain/finality-attestation/v1',
    net.verifier.payload('prepare', message), signature, net.verifier.keys[0]!), false);
});

test('recovery model: decided replicas reject further voting and preserve their decision on restart', () => {
  const net = network(4);
  const commits = finish(net, net.replicas[0]!.propose(X));
  net.restart(0);
  assert.equal(net.replicas[0]!.decide(commits), X);
  assert.throws(() => net.replicas[0]!.changeView(1), /already decided/);
  // Even an artificially forged quorum beyond the assumed fault bound must
  // not overwrite this replica's already persisted decision.
  const conflicting = commits.map(v => {
    const { signature: _, ...unsigned } = { ...v, value: Y };
    return { ...unsigned, signature: net.verifier.sign('commit', unsigned, net.keys[v.signer]!) };
  });
  assert.throws(() => net.replicas[0]!.decide(conflicting), /Conflicting model finality/);
  assert.equal(net.replicas[0]!.snapshot().decided, X);
});

for (const count of [4, 7]) {
  test(`recovery model: ${count} members progress without the Byzantine minority after an equivocating leader`, () => {
    const net = network(count);
    const faulty = Math.floor((count - 1) / 3);
    const honest = net.replicas.slice(faulty);
    for (let i = 0; i < honest.length; i++) {
      const proposal = { view: 0, value: i % 2 === 0 ? X : Y, changes: [], signer: 0 };
      honest[i]!.prepare({ ...proposal, signature: net.verifier.sign('proposal', proposal, net.keys[0]!) });
    }
    // The faulty validators now withhold all messages. A later honest leader
    // gathers the honest quorum; no participation from the minority is needed.
    const view = faulty;
    const changes = honest.map(r => r.changeView(view));
    const proposal = net.replicas[faulty]!.propose(X, changes);
    const prepares = honest.map(r => r.prepare(proposal));
    const commits = honest.map(r => r.commit(prepares));
    for (const replica of honest) assert.equal(replica.decide(commits), X);
    net.restart(0);
    assert.equal(net.replicas[0]!.decide(commits), X);
  });
}

test('recovery model: enumerate 64 partial-commit delivery and new-view quorum schedules', () => {
  for (let delivered = 0; delivered < 16; delivered++) {
    for (let omitted = 0; omitted < 4; omitted++) {
      const net = network(4);
      const initial = net.replicas[0]!.propose(X);
      const prepares = net.replicas.map(r => r.prepare(initial)).slice(0, net.quorum);
      const earlierCommits = net.replicas.flatMap((r, id) => (delivered & (1 << id)) ? [r.commit(prepares)] : []);
      net.replicas.forEach((_, id) => net.restart(id));
      const changes = net.replicas.map(r => r.changeView(1)).filter((_, id) => id !== omitted);
      const required = net.verifier.highest(changes, 1);
      const value = required ? required[0]!.value : Y;
      if (earlierCommits.length >= net.quorum) assert.equal(value, X, `lost hidden finality: ${delivered}/${omitted}`);
      const newCommits = finish(net, net.replicas[1]!.propose(value, changes));
      assert.equal(new Set(net.replicas.map(r => r.snapshot().decided)).size, 1);
      if (earlierCommits.length >= net.quorum) {
        assert.equal(net.replicas[0]!.decide(earlierCommits.slice(0, net.quorum)), X);
      }
      assert.equal(newCommits[0]!.value, value);
    }
  }
});

for (const phase of ['commit', 'change'] as const) {
  for (const afterWrite of [false, true]) {
    test(`recovery model: ${phase} fail-stop and restart with ${afterWrite ? 'ambiguous' : 'absent'} persistence`, () => {
      const net = network(4);
      let fail = false;
      let saved: ModelState | undefined;
      const replica = new RecoveryReplica(net.verifier, net.keys[1]!, state => {
        if (!fail || afterWrite) saved = structuredClone(state);
        if (fail) throw new Error('injected');
      });
      const proposal = net.replicas[0]!.propose(X);
      const own = replica.prepare(proposal);
      const prepares = [own, net.replicas[0]!.prepare(proposal), net.replicas[2]!.prepare(proposal)];
      if (phase === 'change') replica.commit(prepares);
      fail = true;
      assert.throws(() => phase === 'commit' ? replica.commit(prepares) : replica.changeView(1), /persistence fault/);
      assert.throws(() => replica.prepare(proposal), /persistence fault/);
      const recovered = new RecoveryReplica(net.verifier, net.keys[1]!, state => { saved = state; }, saved);
      if (phase === 'commit') {
        assert.equal(recovered.commit(prepares).value, X);
        assert.equal(recovered.changeView(1).prepared![0]!.value, X);
      } else {
        assert.equal(recovered.changeView(1).prepared![0]!.value, X);
        assert.throws(() => recovered.prepare(proposal), /Stale model view/);
      }
    });
  }
}

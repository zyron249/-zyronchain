// P0-03 finding reproducer: after protocol v6 is active, a quorum-approved
// protocol_upgrade back to a legacy version (v5) is accepted by mempool
// admission and by block validation, and schedules a return to the legacy
// single-phase consensus (the F-01 split) at its activation height.
// Expected (this test): such a downgrade is refused. It FAILS on main
// (admitted by all 4 nodes, included at height 101, protocolVersionAt(301) = 5).
import assert from "node:assert/strict";
import test from "node:test";

import { roundStart } from "../src/consensus-v6.js";
import { produceFinalizedBlock } from "../src/node.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import {
  ACTIVATION_HEIGHT,
  MemoryNetwork,
  closeValidators,
  finalizedPrefix,
  openValidator,
  proposerIndex,
  testNetwork,
  type TestValidator
} from "./support/consensus-harness.js";

test("P0-03 rollback: a governance protocol_upgrade from v6 back to v5 is refused after v6 activation", { timeout: 120_000 }, async () => {
  const H = ACTIVATION_HEIGHT;
  const network = testNetwork(4, 0xc1, "zyron-v6fault-downgrade");
  const validators: TestValidator[] = [];
  const prefix = finalizedPrefix(network, 6);
  for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
  try {
    const chain = validators[0]!.service.store.chain;
    const activationHeight = H + 200;
    const proposal = { chainId: network.chainId, nonce: 2, sender: network.genesis.validators[0]!.address, activationHeight, protocolVersion: 5 };
    const downgrade = createProtocolUpgrade({
      ...proposal,
      approvals: network.privateKeys.map((key, index) => createProtocolUpgradeApproval(proposal, key, network.publicKeys[index]!, 2)),
      timestampMs: chain.tip.header.timestampMs + 10
    }, network.privateKeys[0]!, network.publicKeys[0]!, 2);
    let admitted = 0;
    for (const validator of validators) {
      try { validator.service.submitTransaction(structuredClone(downgrade)); admitted += 1; } catch { /* refused */ }
    }
    let now = roundStart(chain.tip.header.timestampMs, 0) + 500;
    const memory = new MemoryNetwork(validators, () => now);
    const leader = proposerIndex(network, H, 0);
    const block = await produceFinalizedBlock(validators[leader]!.service, memory.peersFor(leader), network.privateKeys[leader]!, now);
    assert.ok(block, "height H finalizes");
    for (const validator of validators) if (validator.service.status().height < H) await validator.service.acceptFinalizedBlock(block);
    const included = block.transactions.some((tx) => tx.txid === downgrade.txid);
    now += 1;
    assert.deepEqual(
      { admitted, included, versionAtActivation: validators[0]!.service.store.chain.protocolVersionAt(activationHeight) },
      { admitted: 0, included: false, versionAtActivation: 6 },
      "a v6 chain must not schedule a return to legacy consensus"
    );
  } finally {
    await closeValidators(validators);
  }
});

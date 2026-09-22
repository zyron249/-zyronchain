# Consensus 1.1 upgrade runbook

Status: documentation only. This runbook was not executed against a live network. Public testnet has not been launched. Activation flags stay false.

## Preferred path for the network that does not exist yet

All validators start on consensus wire `/zyronchain/consensus/1.1.0` before height 1. There is no 1.0 round to drain. Chain genesis protocol version stays 1 (`initialProtocolVersion` in the candidate governance input). Mining protocol 5 is a later chain upgrade with delay 100. It is not this consensus wire version.

Operator steps when a network is actually authorized later:

1. Confirm `publicTestnetActivationAllowed`, `publicMiningActivated`, `publicationAllowed`, and `mainnetActivationAllowed` are still false until a separate authorization says otherwise. This runbook does not flip them.
2. Install the same 1.1 binary on every validator. Do not leave a 1.0 consensus process in the peer set.
3. Give each validator its own key, data directory, journal, and listen port. Do not share a signing journal.
4. If an external signer is used, authorize intents `block-proposal`, `round-prepare`, `block-attestation`, and `round-view-change`.
5. Start the processes. Confirm logs show the node serving `/zyronchain/consensus/1.1.0` and that a dial of `/zyronchain/consensus/1.0.0` is rejected.
6. Confirm the first finalized block, when one is produced, has chain header version 1 and a commit quorum of finality attestations. A view-change certificate must not be the only evidence of finality.

No hosts, domains, or keys are specified here. The candidate governance file still has `validators: []`.

## Future live upgrade (not executed)

Use this section only for a later network that already finalized blocks on consensus 1.0. Do not run it now.

1. Halt block production. Mixed operation is not supported, so do not upgrade one validator while others still serve `/zyronchain/consensus/1.0.0`.
2. Stop every validator.
3. Upgrade every binary to 1.1.
4. Start them together on the existing data directories only if those directories contain no `prepare` or `view` journal lines and no `lock-certificates/` files. A directory written by 1.1 must not be rolled back onto a 1.0 binary.
5. Reject any peer that still offers only 1.0. A failed handshake must not be retried into a consensus vote. The 1.1 handler does not accept the 1.0 protocol id, so there is no partial join on that stream.
6. Produce the next height only after every validator is on 1.1.

There is no in-round upgrade height and no flag that switches consensus 1.0 to 1.1. Chain protocol version and consensus wire version are different fields.

## Rollback

Rollback is redeploy of the previous binary on directories that have never stored a 1.1 prepare line, view line, or lock certificate. After those bytes exist, the previous binary is not a compatible reader. Do not use activation flags as a rollback switch.

## What this runbook refuses

- Starting public testnet.
- Inventing validator keys, bootstrap peers, or DNS names.
- Running 1.0 and 1.1 consensus in one quorum.
- Changing 50M / 6.25 / 4M / 20-bit / 1 claim per block.
- Treating a green local test as authorization to produce a public genesis.

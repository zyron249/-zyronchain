# Mixed version

**Not supported.**

`registerP2PConsensusProtocol` handles only `/zyronchain/consensus/1.1.0`. A connection that negotiates Noise can still fail `newStream("/zyronchain/consensus/1.0.0")` before the consensus handler reads a frame. No prepare, commit, or view-change is applied. Height stays 0 across repeated rejected protocol selections. A following 1.1 stream still finalizes, which is the check that the rejects did not wedge the node.

The operational test keeps one Noise connection open and calls `newStream("/zyronchain/consensus/1.0.0")` eight times. Each call rejects with `UnsupportedProtocolError: Protocol selection failed`. The connection stays open, the remote has one connection, and both heights stay 0. A following `newStream("/zyronchain/consensus/1.1.0")` selects that protocol. After close, the remote connection count returns to 0, and `produceFinalizedBlock` over the 1.1 client finalizes one header-version-1 block with both nodes at the same tip.

Back-to-back TCP dials that do not wait for the previous close are not the proof. The transport can reset a later dial while the previous connection is still closing. That reset is not a consensus join and is not counted as one.

Do not operate a quorum that mixes these protocol ids. Old nodes would still treat a finality attestation as their first vote. New nodes wait for a prepare quorum. That split is unsupported.

# ZyronChain multi-process native P2P recovery rehearsal

Status: **pre-public-testnet CI evidence**  
Scope: separate CLI processes, real loopback TCP/Noise/yamux transport, finalized-block sync and hard-crash recovery

## Purpose

In-process libp2p tests prove protocol behavior but share one JavaScript runtime, scheduler and process lifetime. The public-network gate needs evidence that normal CLI nodes can exchange authenticated finalized history across actual sockets and that a hard-crashed node can restart from its durable prefix and catch up without manual state surgery.

`l1/scripts/multiprocess-native-recovery.mjs` is executed by the dedicated `multiprocess-native-recovery` Standalone L1 CI job.

## Rehearsed sequence

The job launches three separate `zyron-l1 node` child processes with distinct data directories and RPC ports:

1. a seed starts a real native libp2p listener on loopback TCP and publishes its Noise-authenticated `/p2p/<PeerId>` address;
2. the rehearsal constructs ten fully finalized two-validator blocks and submits them through the seed's real RPC `/block` boundary;
3. malformed consensus JSON is sent to the live seed and must be rejected without changing finalized height;
4. two independent replica processes start with the seed as their configured native P2P peer;
5. each replica performs native finalized-history sync and must reach the exact height-10 tip hash;
6. one replica is terminated with `SIGKILL`, exercising abrupt process death with no application cleanup;
7. the seed advances to height 20 while the crashed replica is absent;
8. the surviving replica must catch up over periodic native P2P sync to the exact height-20 tip;
9. replay of the already-finalized height-20 block over RPC must be rejected without changing the seed's finalized state;
10. the crashed replica restarts from the same data directory and same persistent node identity, then performs initial native P2P catch-up from its durable height-10 prefix to height 20;
11. seed, live replica and restarted replica must report the same chain ID, height and finalized tip hash;
12. the live processes terminate through the normal SIGTERM drain path, while the earlier crashed process provides the hard-crash boundary.

## Evidence boundary

This closes a specific gap between in-process network tests and a real deployment: the transport, process isolation, OS sockets, persistent node identity, writer-lock release after `SIGKILL`, durable prefix recovery and native sync all execute through compiled CLI nodes.

It does **not** authorize public testnet and does not replace:

- separate physical/cloud hosts, regions and operators;
- Internet latency, loss, reordering, NAT and bandwidth pressure;
- simultaneous Byzantine consensus traffic and eclipse/Sybil routing;
- production remote signer/HSM recovery;
- process crash at the same moment as disk corruption or power loss;
- sustained multi-hour/day public-network soak;
- independent operational evidence and external review.

Those remain stop-ship gates.

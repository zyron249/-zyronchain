# Independent light-client verifier

This directory is a deliberately narrow second implementation of the public
ZyronChain light-client verification rules. It is an assurance tool, not a node,
wallet, network client, or source of a trust anchor.

It does **not** import the TypeScript L1 implementation. Python independently
implements the protocol serialization, header/quorum checks, address binding and
State-v2 proof calculation. ECDSA/secp256k1 arithmetic is not reimplemented:
verification uses pinned `coincurve` 21.0.0, backed by libsecp256k1.

The fixtures cover both a round-0 finalization with a State-v2 membership proof
and a round-1 finalization whose proposer is unlocked only by an authenticated
round-0 skip quorum. A separate State-v2 fixture locks positive non-membership
verification. They contain public keys/signatures only, never private keys.

Run it from this directory after installing the pinned dependency:

```sh
python -m pip install --require-hashes -r requirements.txt
python -m unittest -v test_verify_vector.py
python verify_vector.py ../test-vectors/light-client-v1.json
```

Protocol v6 (the F-01 locked two-phase consensus) is not implemented by this
verifier yet. It fails closed on v6 anchors, protocol transitions to v6 and
v6-shaped finality proofs (`python -m unittest -v test_protocol_v6_fail_closed.py`);
use the TypeScript light client for v6 until the port lands.

Passing this verifier means the supplied proof is consistent with its supplied
anchor. It does not make that anchor trustworthy. A production light client must
obtain the chain/genesis identity, finalized checkpoint and validator set through
an independently authenticated trust path as described in the L1 README.

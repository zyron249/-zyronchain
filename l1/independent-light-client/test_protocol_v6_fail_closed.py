"""F-01: the independent verifier does not implement protocol v6 consensus
(locked two-phase BFT, CommitVote finality certificates with a commitRound).
Until it does, every v6 structure must be rejected (fail closed), never
verified with the legacy attestation rules."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from verify_vector import (
    SUPPORTED_PROTOCOL_VERSIONS,
    VerificationError,
    activate_next_protocol_version,
    validate_anchor,
    verify_next_finalized,
    verify_vector,
)

VECTORS = Path(__file__).parents[1] / "test-vectors"


def load(name: str):
    return json.loads((VECTORS / name).read_text(encoding="utf-8"))


class ProtocolV6FailClosedTest(unittest.TestCase):
    def test_v6_is_not_a_supported_version(self) -> None:
        self.assertNotIn(6, SUPPORTED_PROTOCOL_VERSIONS)

    def test_v6_anchor_is_rejected(self) -> None:
        anchor = load("light-client-v1.json")["anchor"]
        anchor["protocolVersion"] = 6
        with self.assertRaises(VerificationError):
            validate_anchor(anchor)

    def test_v6_transition_is_rejected_before_any_proof_check(self) -> None:
        anchor = load("light-client-v1.json")["anchor"]
        anchor["protocolVersion"] = 5
        with self.assertRaisesRegex(VerificationError, "unsupported protocol transition version"):
            activate_next_protocol_version(anchor, 6, {"version": 1, "keyHash": "00" * 32, "valueHash": "00" * 32, "siblings": []})

    def test_v6_shaped_finality_proof_is_rejected(self) -> None:
        vector = load("light-client-v1.json")
        proof = dict(vector["finalityProof"])
        proof["commitRound"] = 0
        with self.assertRaises(VerificationError):
            verify_next_finalized(vector["anchor"], proof)
        proof["version"] = 2
        with self.assertRaises(VerificationError):
            verify_next_finalized(vector["anchor"], proof)

    def test_v6_header_against_v6_anchor_is_rejected(self) -> None:
        vector = load("light-client-v1.json")
        vector["anchor"]["protocolVersion"] = 6
        vector["finalityProof"]["header"]["version"] = 6
        with self.assertRaises(VerificationError):
            verify_vector(vector)


if __name__ == "__main__":
    unittest.main()

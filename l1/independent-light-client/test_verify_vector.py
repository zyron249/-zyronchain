from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from verify_vector import canonical_json, VerificationError, verify_next_finalized, verify_state_proof, verify_vector


VECTOR_PATH = Path(__file__).parents[1] / "test-vectors" / "light-client-v1.json"
ROUND_ONE_VECTOR_PATH = Path(__file__).parents[1] / "test-vectors" / "light-client-v1-round1.json"
NONMEMBERSHIP_VECTOR_PATH = Path(__file__).parents[1] / "test-vectors" / "state-v2-nonmembership-v1.json"


def load_vector():
    return json.loads(VECTOR_PATH.read_text(encoding="utf-8"))


def load_round_one_vector():
    return json.loads(ROUND_ONE_VECTOR_PATH.read_text(encoding="utf-8"))


class IndependentLightClientTests(unittest.TestCase):
    def test_canonical_key_order_matches_utf16_protocol_rule(self):
        value = {"é": 6, "z": 4, "_": 2, "😀": 7, "a": 3, "ä": 5, "A": 1}
        self.assertEqual(
            canonical_json(value),
            '{"A":1,"_":2,"a":3,"z":4,"ä":5,"é":6,"😀":7}'.encode(),
        )

    def test_public_vector_verifies(self):
        verify_vector(load_vector())

    def test_header_hash_substitution_fails(self):
        vector = load_vector()
        vector["finalityProof"]["hash"] = "00" * 32
        with self.assertRaises(VerificationError):
            verify_vector(vector)

    def test_proposer_signature_substitution_fails(self):
        vector = load_vector()
        vector["finalityProof"]["signature"] = "00" * 64
        with self.assertRaises(VerificationError):
            verify_vector(vector)

    def test_finality_requires_strict_supermajority(self):
        vector = load_vector()
        proof = vector["finalityProof"]
        proof["attestations"] = proof["attestations"][:2]
        with self.assertRaisesRegex(VerificationError, "quorum"):
            verify_next_finalized(vector["anchor"], proof)

    def test_duplicate_attestation_does_not_count_twice(self):
        vector = load_vector()
        proof = vector["finalityProof"]
        proof["attestations"][1] = copy.deepcopy(proof["attestations"][0])
        with self.assertRaisesRegex(VerificationError, "duplicate"):
            verify_next_finalized(vector["anchor"], proof)

    def test_wrong_trust_anchor_fails(self):
        vector = load_vector()
        vector["anchor"]["blockHash"] = "44" * 32
        with self.assertRaises(VerificationError):
            verify_next_finalized(vector["anchor"], vector["finalityProof"])

    def test_round_one_requires_authenticated_skip_quorum(self):
        vector = load_round_one_vector()
        next_anchor = verify_next_finalized(vector["anchor"], vector["finalityProof"])
        self.assertEqual(next_anchor["blockHash"], vector["finalityProof"]["hash"])
        short = copy.deepcopy(vector["finalityProof"])
        short["roundCertificate"] = short["roundCertificate"][:2]
        with self.assertRaisesRegex(VerificationError, "skip quorum"):
            verify_next_finalized(vector["anchor"], short)
        forged = copy.deepcopy(vector["finalityProof"])
        forged["roundCertificate"][0]["signature"] = "00" * 64
        with self.assertRaisesRegex(VerificationError, "skip signature"):
            verify_next_finalized(vector["anchor"], forged)

    def test_state_root_key_and_value_substitution_fail(self):
        vector = load_vector()
        next_anchor = verify_next_finalized(vector["anchor"], vector["finalityProof"])
        state = vector["stateProof"]
        self.assertTrue(verify_state_proof(next_anchor, state["key"], state["value"], state["proof"]))
        wrong_anchor = {**next_anchor, "stateRoot": "55" * 32}
        self.assertFalse(verify_state_proof(wrong_anchor, state["key"], state["value"], state["proof"]))
        self.assertFalse(verify_state_proof(next_anchor, "account:bob", state["value"], state["proof"]))
        wrong_value = {**state["value"], "balanceAtoms": state["value"]["balanceAtoms"] + 1}
        self.assertFalse(verify_state_proof(next_anchor, state["key"], wrong_value, state["proof"]))

    def test_state_sibling_substitution_fails(self):
        vector = load_vector()
        next_anchor = verify_next_finalized(vector["anchor"], vector["finalityProof"])
        state = vector["stateProof"]
        proof = copy.deepcopy(state["proof"])
        proof["siblings"][0] = "66" * 32
        self.assertFalse(verify_state_proof(next_anchor, state["key"], state["value"], proof))

    def test_public_nonmembership_vector_verifies_and_rejects_substitution(self):
        vector = json.loads(NONMEMBERSHIP_VECTOR_PATH.read_text(encoding="utf-8"))
        anchor = {
            **load_vector()["expectedNext"],
            "stateRoot": vector["root"],
        }
        self.assertIsNone(vector["value"])
        self.assertTrue(verify_state_proof(anchor, vector["key"], None, vector["proof"]))
        self.assertFalse(verify_state_proof(anchor, "account:mallory", None, vector["proof"]))
        forged = copy.deepcopy(vector["proof"])
        forged["siblings"][0] = "66" * 32
        self.assertFalse(verify_state_proof(anchor, vector["key"], None, forged))


if __name__ == "__main__":
    unittest.main()

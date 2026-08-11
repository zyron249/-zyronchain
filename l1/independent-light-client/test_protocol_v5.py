from __future__ import annotations

import json
import unittest
from pathlib import Path

from verify_vector import (
    BRANCH_DOMAIN,
    EMPTY_HASHES,
    KEY_DOMAIN,
    LEAF_DOMAIN,
    TREE_DEPTH,
    VALUE_DOMAIN,
    VerificationError,
    _domain_hash,
    activate_next_protocol_version,
    canonical_json,
    validate_anchor,
    verify_state_proof,
)


VECTOR_PATH = Path(__file__).parents[1] / "test-vectors" / "light-client-v1.json"


def base_anchor():
    vector = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    return vector["anchor"]


def single_leaf_state(key: str, value: object):
    key_hash = _domain_hash(KEY_DOMAIN, key.encode("utf-8"))
    value_hash = _domain_hash(VALUE_DOMAIN, canonical_json(value))
    siblings = [EMPTY_HASHES[depth + 1] for depth in range(TREE_DEPTH)]
    current = _domain_hash(LEAF_DOMAIN, bytes.fromhex(key_hash), bytes.fromhex(value_hash))
    key_bytes = bytes.fromhex(key_hash)
    for depth in range(TREE_DEPTH - 1, -1, -1):
        sibling = siblings[depth]
        bit = (key_bytes[depth // 8] >> (7 - depth % 8)) & 1
        current = (
            _domain_hash(BRANCH_DOMAIN, bytes.fromhex(current), bytes.fromhex(sibling))
            if bit == 0
            else _domain_hash(BRANCH_DOMAIN, bytes.fromhex(sibling), bytes.fromhex(current))
        )
    return current, {
        "version": 1,
        "keyHash": key_hash,
        "valueHash": value_hash,
        "siblings": siblings,
    }


class IndependentProtocolV5Tests(unittest.TestCase):
    def test_protocol_v5_state_and_transition_proofs_are_supported(self):
        key = "protocol-schedule:101"
        value = {"protocolVersion": 5}
        root, proof = single_leaf_state(key, value)
        anchor = {
            **base_anchor(),
            "height": 100,
            "stateRoot": root,
            "protocolVersion": 3,
        }

        transitioned = activate_next_protocol_version(anchor, 5, proof)
        self.assertEqual(transitioned["protocolVersion"], 5)
        self.assertTrue(verify_state_proof(transitioned, key, value, proof))

    def test_unknown_protocols_fail_closed_for_anchor_and_transition(self):
        key = "protocol-schedule:101"
        root, proof = single_leaf_state(key, {"protocolVersion": 5})
        anchor = {
            **base_anchor(),
            "height": 100,
            "stateRoot": root,
            "protocolVersion": 3,
        }
        with self.assertRaisesRegex(VerificationError, "unsupported protocol transition"):
            activate_next_protocol_version(anchor, 4, proof)
        with self.assertRaisesRegex(VerificationError, "unsupported anchor protocol"):
            validate_anchor({**anchor, "protocolVersion": 4})

    def test_protocol_transition_proof_is_bound_to_next_height_and_value(self):
        key = "protocol-schedule:101"
        root, proof = single_leaf_state(key, {"protocolVersion": 5})
        anchor = {
            **base_anchor(),
            "height": 100,
            "stateRoot": root,
            "protocolVersion": 3,
        }
        with self.assertRaisesRegex(VerificationError, "invalid protocol transition proof"):
            activate_next_protocol_version({**anchor, "height": 99}, 5, proof)
        wrong_root, wrong_proof = single_leaf_state(key, {"protocolVersion": 3})
        self.assertNotEqual(root, wrong_root)
        with self.assertRaisesRegex(VerificationError, "invalid protocol transition proof"):
            activate_next_protocol_version(anchor, 5, wrong_proof)


if __name__ == "__main__":
    unittest.main()

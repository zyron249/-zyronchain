#!/usr/bin/env python3
"""Independent verifier for ZyronChain public light-client test vectors.

This intentionally does not import the TypeScript L1 implementation.  Curve
arithmetic and ECDSA verification are delegated to libsecp256k1 via coincurve.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

from coincurve import PublicKey, ecdsa


MAX_SAFE_INTEGER = 9_007_199_254_740_991
HEX_32 = re.compile(r"^[0-9a-f]{64}$")
HEX_64 = re.compile(r"^[0-9a-f]{128}$")
ADDRESS = re.compile(r"^ZYN[0-9a-f]{40}$")
CHAIN_ID = re.compile(r"^[a-z0-9-]{3,64}$")
TREE_DEPTH = 256
KEY_DOMAIN = b"ZyronChain/state-v2/key\x00"
VALUE_DOMAIN = b"ZyronChain/state-v2/value\x00"
LEAF_DOMAIN = b"ZyronChain/state-v2/leaf\x00"
EMPTY_LEAF_DOMAIN = b"ZyronChain/state-v2/empty-leaf\x00"
BRANCH_DOMAIN = b"ZyronChain/state-v2/branch\x00"


class VerificationError(ValueError):
    pass


def _safe_int(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise VerificationError(f"{label} must be an integer")
    if value < minimum or value > MAX_SAFE_INTEGER:
        raise VerificationError(f"{label} is outside the safe integer range")
    return value


def _exact_keys(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise VerificationError(f"invalid {label} schema")
    return value


def _hex(value: Any, pattern: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise VerificationError(f"invalid {label}")
    return value


def _validate_json_value(value: Any) -> None:
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > MAX_SAFE_INTEGER:
            raise VerificationError("JSON integer is outside the safe integer range")
        return
    if isinstance(value, list):
        for item in value:
            _validate_json_value(item)
        return
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        for item in value.values():
            _validate_json_value(item)
        return
    raise VerificationError("unsupported canonical JSON value")


def _utf16_key(value: str) -> bytes:
    # Mirrors ECMAScript relational string ordering: lexicographic UTF-16 code
    # units. It is explicit and therefore independent of Python's locale.
    return value.encode("utf-16-be", errors="surrogatepass")


def _normalize_key_order(value: Any) -> Any:
    if isinstance(value, list):
        return [_normalize_key_order(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _normalize_key_order(value[key])
            for key in sorted(value, key=_utf16_key)
        }
    return value


def canonical_json(value: Any) -> bytes:
    """Canonical encoding using locale-independent UTF-16 object-key order."""
    _validate_json_value(value)
    return json.dumps(
        _normalize_key_order(value),
        sort_keys=False,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def sha256(*parts: bytes) -> bytes:
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part)
    return digest.digest()


def address_from_public_key(public_key: str) -> str:
    _hex(public_key, HEX_64, "validator public key")
    return "ZYN" + sha256(bytes.fromhex(public_key)).hex()[:40]


def verify_signature(payload: Any, signature: str, public_key: str) -> bool:
    try:
        raw_signature = bytes.fromhex(_hex(signature, HEX_64, "signature"))
        raw_public_key = bytes.fromhex(_hex(public_key, HEX_64, "public key"))
        der_signature = ecdsa.cdata_to_der(ecdsa.deserialize_compact(raw_signature))
        return PublicKey(b"\x04" + raw_public_key).verify(
            der_signature,
            canonical_json(payload),
            hasher=lambda message: sha256(message),
        )
    except (ValueError, VerificationError):
        return False


def validate_anchor(value: Any) -> dict[str, Any]:
    anchor = _exact_keys(
        value,
        {
            "version", "chainId", "genesisHash", "height", "blockHash",
            "stateRoot", "timestampMs", "protocolVersion", "validators",
        },
        "anchor",
    )
    if anchor["version"] != 1 or not isinstance(anchor["chainId"], str) or not CHAIN_ID.fullmatch(anchor["chainId"]):
        raise VerificationError("invalid anchor identity")
    _safe_int(anchor["height"], "anchor height")
    _safe_int(anchor["timestampMs"], "anchor timestamp")
    _safe_int(anchor["protocolVersion"], "anchor protocol version", 1)
    _hex(anchor["genesisHash"], HEX_32, "genesis hash")
    _hex(anchor["blockHash"], HEX_32, "block hash")
    _hex(anchor["stateRoot"], HEX_32, "state root")
    validators = anchor["validators"]
    if not isinstance(validators, list) or not 1 <= len(validators) <= 100:
        raise VerificationError("invalid validator cardinality")
    seen: set[str] = set()
    for raw_validator in validators:
        validator = _exact_keys(raw_validator, {"address", "publicKey"}, "validator")
        public_key = _hex(validator["publicKey"], HEX_64, "validator public key")
        if not isinstance(validator["address"], str) or ADDRESS.fullmatch(validator["address"]) is None:
            raise VerificationError("invalid validator address")
        if validator["address"] != address_from_public_key(public_key) or validator["address"] in seen:
            raise VerificationError("validator address binding or uniqueness failed")
        # Parse the curve point here, not only when a particular validator signs.
        try:
            PublicKey(b"\x04" + bytes.fromhex(public_key))
        except ValueError as exc:
            raise VerificationError("invalid validator curve point") from exc
        seen.add(validator["address"])
    return anchor


def _validate_header(value: Any) -> dict[str, Any]:
    header = _exact_keys(
        value,
        {
            "version", "chainId", "height", "round", "previousHash",
            "timestampMs", "transactionRoot", "stateRoot", "proposer",
        },
        "header",
    )
    _safe_int(header["version"], "header version", 1)
    _safe_int(header["height"], "header height")
    _safe_int(header["round"], "header round")
    _safe_int(header["timestampMs"], "header timestamp")
    if not isinstance(header["chainId"], str):
        raise VerificationError("invalid header chain ID")
    _hex(header["previousHash"], HEX_32, "previous hash")
    _hex(header["transactionRoot"], HEX_32, "transaction root")
    _hex(header["stateRoot"], HEX_32, "state root")
    if not isinstance(header["proposer"], str) or ADDRESS.fullmatch(header["proposer"]) is None:
        raise VerificationError("invalid proposer address")
    return header


def quorum_size(validator_count: int) -> int:
    return validator_count * 2 // 3 + 1


def _validator_map(validators: list[dict[str, str]]) -> dict[str, str]:
    return {item["address"]: item["publicKey"] for item in validators}


def _verify_round_certificate(
    header: dict[str, Any], votes: Any, validators: list[dict[str, str]]
) -> None:
    if not isinstance(votes, list) or len(votes) > len(validators):
        raise VerificationError("invalid round certificate cardinality")
    if header["round"] == 0:
        if votes:
            raise VerificationError("round 0 cannot carry a skip certificate")
        return
    allowed = _validator_map(validators)
    seen: set[str] = set()
    for raw_vote in votes:
        vote = _exact_keys(
            raw_vote,
            {"validator", "publicKey", "chainId", "height", "round", "previousHash", "signature"},
            "round skip vote",
        )
        public_key = _hex(vote["publicKey"], HEX_64, "round skip public key")
        _hex(vote["previousHash"], HEX_32, "round skip previous hash")
        _hex(vote["signature"], HEX_64, "round skip signature")
        _safe_int(vote["height"], "round skip height", 1)
        _safe_int(vote["round"], "round skip round")
        validator = vote["validator"]
        if not isinstance(validator, str) or validator in seen or allowed.get(validator) != public_key:
            raise VerificationError("unknown or duplicate round skip voter")
        if (
            vote["chainId"] != header["chainId"]
            or vote["height"] != header["height"]
            or vote["round"] != header["round"] - 1
            or vote["previousHash"] != header["previousHash"]
        ):
            raise VerificationError("round skip vote does not bind proposal")
        payload = {key: value for key, value in vote.items() if key != "signature"}
        if not verify_signature(payload, vote["signature"], public_key):
            raise VerificationError("invalid round skip signature")
        seen.add(validator)
    if len(seen) < quorum_size(len(validators)):
        raise VerificationError("round skip quorum not reached")


def _verify_attestations(
    header: dict[str, Any], block_hash: str, attestations: Any, validators: list[dict[str, str]]
) -> None:
    if not isinstance(attestations, list) or len(attestations) > len(validators):
        raise VerificationError("invalid attestation cardinality")
    allowed = _validator_map(validators)
    seen: set[str] = set()
    payload = {"chainId": header["chainId"], "height": header["height"], "blockHash": block_hash}
    for raw_attestation in attestations:
        attestation = _exact_keys(raw_attestation, {"validator", "publicKey", "signature"}, "attestation")
        public_key = _hex(attestation["publicKey"], HEX_64, "attestation public key")
        _hex(attestation["signature"], HEX_64, "attestation signature")
        validator = attestation["validator"]
        if not isinstance(validator, str) or validator in seen or allowed.get(validator) != public_key:
            raise VerificationError("unknown or duplicate attesting validator")
        if not verify_signature(payload, attestation["signature"], public_key):
            raise VerificationError("invalid attestation signature")
        seen.add(validator)
    if len(seen) < quorum_size(len(validators)):
        raise VerificationError("finality quorum not reached")


def verify_next_finalized(anchor_value: Any, proof_value: Any) -> dict[str, Any]:
    anchor = validate_anchor(anchor_value)
    proof = _exact_keys(
        proof_value,
        {"version", "header", "hash", "proposerPublicKey", "signature", "roundCertificate", "attestations"},
        "finality proof",
    )
    if proof["version"] != 1:
        raise VerificationError("unsupported finality proof version")
    header = _validate_header(proof["header"])
    block_hash = _hex(proof["hash"], HEX_32, "proof block hash")
    proposer_public_key = _hex(proof["proposerPublicKey"], HEX_64, "proposer public key")
    _hex(proof["signature"], HEX_64, "proposer signature")
    if header["chainId"] != anchor["chainId"]:
        raise VerificationError("chain ID mismatch")
    if header["height"] != anchor["height"] + 1 or header["previousHash"] != anchor["blockHash"]:
        raise VerificationError("header does not extend anchor")
    if header["timestampMs"] <= anchor["timestampMs"] or header["version"] != anchor["protocolVersion"]:
        raise VerificationError("timestamp or protocol continuity failed")
    expected_hash = sha256(canonical_json(header)).hex()
    if block_hash != expected_hash:
        raise VerificationError("block hash mismatch")
    validators = anchor["validators"]
    expected = validators[(header["height"] - 1 + header["round"]) % len(validators)]
    if header["proposer"] != expected["address"] or proposer_public_key != expected["publicKey"]:
        raise VerificationError("unexpected proposer")
    if not verify_signature(header, proof["signature"], proposer_public_key):
        raise VerificationError("invalid proposer signature")
    _verify_round_certificate(header, proof["roundCertificate"], validators)
    _verify_attestations(header, block_hash, proof["attestations"], validators)
    return {
        **anchor,
        "height": header["height"],
        "blockHash": block_hash,
        "stateRoot": header["stateRoot"],
        "timestampMs": header["timestampMs"],
    }


def _domain_hash(domain: bytes, *parts: bytes) -> str:
    return sha256(domain, *parts).hex()


def _empty_hashes() -> list[str]:
    hashes = [""] * (TREE_DEPTH + 1)
    hashes[TREE_DEPTH] = _domain_hash(EMPTY_LEAF_DOMAIN)
    for depth in range(TREE_DEPTH - 1, -1, -1):
        child = bytes.fromhex(hashes[depth + 1])
        hashes[depth] = _domain_hash(BRANCH_DOMAIN, child, child)
    return hashes


EMPTY_HASHES = _empty_hashes()


def verify_state_proof(anchor_value: Any, key: Any, value: Any, proof_value: Any) -> bool:
    try:
        anchor = validate_anchor(anchor_value)
        if anchor["protocolVersion"] != 2 or not isinstance(key, str) or not key:
            return False
        proof = _exact_keys(proof_value, {"version", "keyHash", "valueHash", "siblings"}, "state proof")
        if proof["version"] != 1 or not isinstance(proof["siblings"], list) or len(proof["siblings"]) != TREE_DEPTH:
            return False
        key_hash = _domain_hash(KEY_DOMAIN, key.encode("utf-8"))
        if proof["keyHash"] != key_hash:
            return False
        siblings = [_hex(item, HEX_32, "state proof sibling") for item in proof["siblings"]]
        if value is None:
            if proof["valueHash"] is not None:
                return False
            current = EMPTY_HASHES[TREE_DEPTH]
        else:
            value_hash = _domain_hash(VALUE_DOMAIN, canonical_json(value))
            if proof["valueHash"] != value_hash:
                return False
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
        return current == anchor["stateRoot"]
    except (TypeError, ValueError, VerificationError):
        return False


def verify_vector(document: Any) -> None:
    vector = _exact_keys(document, {"version", "anchor", "finalityProof", "expectedNext", "stateProof"}, "vector")
    if vector["version"] != 1:
        raise VerificationError("unsupported vector version")
    next_anchor = verify_next_finalized(vector["anchor"], vector["finalityProof"])
    if canonical_json(next_anchor) != canonical_json(validate_anchor(vector["expectedNext"])):
        raise VerificationError("finalized anchor differs from expected vector result")
    state = _exact_keys(vector["stateProof"], {"key", "value", "proof"}, "state proof vector")
    if not verify_state_proof(next_anchor, state["key"], state["value"], state["proof"]):
        raise VerificationError("State-v2 proof failed")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} PATH_TO_VECTOR.json", file=sys.stderr)
        return 2
    try:
        document = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        verify_vector(document)
    except (OSError, json.JSONDecodeError, VerificationError) as exc:
        print(f"verification failed: {exc}", file=sys.stderr)
        return 1
    print("independent light-client vector verification: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

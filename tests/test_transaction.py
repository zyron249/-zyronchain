import json

import pytest

from zyron.wallet import Wallet
from zyron.transaction import Transaction


def test_valid_transaction_signature():
    wallet = Wallet()

    tx = Transaction(
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount=10,
        public_key=wallet.get_public_key()
    )

    tx.sign_transaction(wallet.get_private_key())

    assert tx.is_valid() is True


def test_modified_transaction_becomes_invalid():
    wallet = Wallet()

    tx = Transaction(
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount=10,
        public_key=wallet.get_public_key()
    )

    tx.sign_transaction(wallet.get_private_key())

    tx.amount = 999

    assert tx.is_valid() is False


def test_invalid_signature_rejected():
    wallet = Wallet()

    tx = Transaction(
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount=10,
        public_key=wallet.get_public_key()
    )

    tx.signature = "deadbeef"

    assert tx.is_valid() is False


def test_non_finite_transaction_amount_rejected():
    wallet = Wallet()

    with pytest.raises(ValueError, match="finite"):
        Transaction(
            sender=wallet.address,
            receiver="ZYN1234567890abcdef1234567890abcdef123456",
            amount=float("nan"),
            public_key=wallet.get_public_key()
        )


def test_non_finite_transaction_fee_rejected():
    wallet = Wallet()

    with pytest.raises(ValueError, match="finite"):
        Transaction(
            sender=wallet.address,
            receiver="ZYN1234567890abcdef1234567890abcdef123456",
            amount=1,
            fee=float("inf"),
            public_key=wallet.get_public_key()
        )


def test_protocol_v3_signature_is_deterministic():
    wallet = Wallet()

    tx = Transaction(
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount=5,
        public_key=wallet.get_public_key()
    )

    tx.sign_transaction(wallet.get_private_key())
    first_signature = tx.signature
    tx.sign_transaction(wallet.get_private_key())

    assert tx.version == Transaction.CURRENT_VERSION
    assert tx.signature == first_signature
    assert tx.is_valid() is True


def test_protocol_v3_uses_atomic_units_and_canonical_payload():
    wallet = Wallet()
    tx = Transaction(
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount="1.23456789",
        fee="0.00000001",
        public_key=wallet.get_public_key(),
        nonce=7,
        timestamp_ms=1_700_000_000_123
    )
    tx.sign_transaction(wallet.get_private_key())
    wire = tx.to_dict()

    assert wire["amount_atoms"] == 123_456_789
    assert wire["fee_atoms"] == 1
    assert wire["timestamp_ms"] == 1_700_000_000_123
    assert "amount" not in wire
    assert "fee" not in wire
    assert "timestamp" not in wire
    assert json.loads(tx.data_to_sign())["amount_atoms"] == 123_456_789
    assert Transaction.from_dict(wire).is_valid() is True


def test_protocol_v3_rejects_sub_atomic_amounts():
    wallet = Wallet()
    with pytest.raises(ValueError, match="8 decimal places"):
        Transaction(
            sender=wallet.address,
            receiver="ZYN1234567890abcdef1234567890abcdef123456",
            amount="0.000000001",
            public_key=wallet.get_public_key()
        )


def test_protocol_v3_rejects_unknown_consensus_fields():
    wallet = Wallet()
    tx = Transaction(
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount=1,
        public_key=wallet.get_public_key()
    )
    tx.sign_transaction(wallet.get_private_key())
    wire = tx.to_dict()
    wire["ignored_by_parser"] = "but-hashed-by-block"

    with pytest.raises(ValueError, match="Unknown v3 transaction fields"):
        Transaction.from_dict(wire)


def test_protocol_v3_signature_is_low_s():
    wallet = Wallet()
    tx = Transaction(
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount=1,
        public_key=wallet.get_public_key()
    )
    tx.sign_transaction(wallet.get_private_key())

    import ecdsa
    s = int(tx.signature[64:], 16)
    assert s <= ecdsa.SECP256k1.order // 2


def test_protocol_v3_cross_language_vector_is_stable():
    private_key = "01".zfill(64)
    public_key = (
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
    )
    tx = Transaction(
        sender="ZYN09c0b2d1a486c439a87bcba6b46a7a1a23f3897c",
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount_atoms=123_456_789,
        fee_atoms=1,
        public_key=public_key,
        nonce=7,
        timestamp_ms=1_700_000_000_123
    )
    tx.sign_transaction(private_key)

    assert tx.signature == (
        "08b35a9e4828ef24942b016332edef1606dde601e564fae34347e98faa4d3692"
        "6e1dee1631e78858de910ccdc7d1729a09cb25b5fee097a4da539a6adb925ebb"
    )
    assert tx.txid == "4101e21a99b1c2622e33d37d1f959969f00d168b7355643d2efdc312e7ed1d63"


def test_legacy_v1_signature_remains_valid_for_chain_history():
    wallet = Wallet()

    tx = Transaction(
        version=Transaction.LEGACY_VERSION,
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount=5,
        public_key=wallet.get_public_key()
    )

    tx.sign_transaction(wallet.get_private_key())

    assert tx.is_valid() is True


def test_oversized_signature_is_rejected_before_crypto_verification():
    wallet = Wallet()

    tx = Transaction(
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount=1,
        public_key=wallet.get_public_key()
    )
    tx.signature = "aa" * 100_000

    assert tx.is_valid() is False


def test_malformed_txid_is_rejected():
    wallet = Wallet()

    tx = Transaction(
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount=1,
        public_key=wallet.get_public_key()
    )
    tx.sign_transaction(wallet.get_private_key())
    tx.txid = "not-a-valid-txid"

    assert tx.is_valid() is False

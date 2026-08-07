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

    tx = Transaction(
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount=float("nan"),
        public_key=wallet.get_public_key()
    )

    tx.sign_transaction(wallet.get_private_key())

    assert tx.is_valid() is False


def test_non_finite_transaction_fee_rejected():
    wallet = Wallet()

    tx = Transaction(
        sender=wallet.address,
        receiver="ZYN1234567890abcdef1234567890abcdef123456",
        amount=1,
        fee=float("inf"),
        public_key=wallet.get_public_key()
    )

    tx.sign_transaction(wallet.get_private_key())

    assert tx.is_valid() is False


def test_protocol_v2_signature_is_deterministic():
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

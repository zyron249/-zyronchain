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

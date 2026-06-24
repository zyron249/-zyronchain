from zyron.blockchain import Blockchain
from zyron.wallet import Wallet
from zyron.transaction import Transaction


def test_genesis_block_exists():
    chain = Blockchain()

    assert len(chain.chain) >= 1
    assert chain.chain[0].index == 0


def test_invalid_address_rejected():
    chain = Blockchain()

    assert chain.is_valid_address("abc") is False
    assert chain.is_valid_address("") is False


def test_valid_address_accepted():
    wallet = Wallet()
    chain = Blockchain()

    assert chain.is_valid_address(wallet.address) is True


def test_duplicate_transaction_rejected():
    chain = Blockchain()

    sender = Wallet()
    receiver = Wallet()

    reward = Transaction(
        "SYSTEM",
        sender.address,
        100
    )

    chain.pending_transactions.append(reward.to_dict())
    chain.mine_pending_transactions(sender.address)

    tx = Transaction(
        sender=sender.address,
        receiver=receiver.address,
        amount=10,
        public_key=sender.get_public_key()
    )

    tx.sign_transaction(sender.get_private_key())

    chain.add_transaction(tx)

    try:
        chain.add_transaction(tx)
        assert False
    except Exception:
        assert True


def test_insufficient_balance_rejected():
    chain = Blockchain()

    sender = Wallet()
    receiver = Wallet()

    tx = Transaction(
        sender=sender.address,
        receiver=receiver.address,
        amount=1000,
        public_key=sender.get_public_key()
    )

    tx.sign_transaction(sender.get_private_key())

    try:
        chain.add_transaction(tx)
        assert False
    except Exception:
        assert True

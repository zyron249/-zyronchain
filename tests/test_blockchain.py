import pytest
from zyron.block import Block
from zyron.blockchain import Blockchain
from zyron.wallet import Wallet
from zyron.transaction import Transaction


def test_genesis_block_exists():
    chain = Blockchain()

    assert len(chain.chain) >= 1
    assert chain.chain[0].index == 0
    assert chain.is_chain_valid() is True


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
        100,
        fee=0,
        nonce=0
    )

    chain.pending_transactions.append(reward.to_dict())
    chain.mine_pending_transactions(sender.address)

    tx = Transaction(
        sender=sender.address,
        receiver=receiver.address,
        amount=10,
        public_key=sender.get_public_key(),
        nonce=chain.get_next_nonce(sender.address),
        fee=0.01
    )

    tx.sign_transaction(sender.get_private_key())
    chain.add_transaction(tx)

    try:
        chain.add_transaction(tx)
        assert False
    except Exception as error:
        assert "Transaction already exists" in str(error)


def test_insufficient_balance_rejected():
    chain = Blockchain()

    sender = Wallet()
    receiver = Wallet()

    tx = Transaction(
        sender=sender.address,
        receiver=receiver.address,
        amount=1000,
        public_key=sender.get_public_key(),
        nonce=chain.get_next_nonce(sender.address),
        fee=0.01
    )

    tx.sign_transaction(sender.get_private_key())

    try:
        chain.add_transaction(tx)
        assert False
    except Exception as error:
        assert "Insufficient balance" in str(error)


def test_external_system_transaction_rejected():
    chain = Blockchain()
    receiver = Wallet()

    forged_reward = Transaction(
        "SYSTEM",
        receiver.address,
        1_000_000,
        fee=0,
        nonce=0
    )

    with pytest.raises(Exception, match="SYSTEM transactions"):
        chain.add_transaction(forged_reward)


def test_chain_rejects_inflated_mining_reward():
    chain = Blockchain()
    miner = Wallet()

    chain.mine_pending_transactions(miner.address)

    block = chain.get_latest_block()
    reward_data = block.transactions[-1]
    reward_data["amount_atoms"] += 1_000_000 * Transaction.ATOMS_PER_ZYN

    forged_reward = Transaction.from_dict(reward_data)
    reward_data["txid"] = forged_reward.calculate_txid()

    block.nonce = 0
    block.mine()

    assert chain.is_chain_valid() is False


def test_transaction_fees_are_not_counted_as_new_supply():
    chain = Blockchain()
    sender = Wallet()
    receiver = Wallet()
    miner = Wallet()

    chain.mine_pending_transactions(sender.address)

    tx = Transaction(
        sender=sender.address,
        receiver=receiver.address,
        amount=1,
        fee=2,
        public_key=sender.get_public_key(),
        nonce=chain.get_next_nonce(sender.address)
    )
    tx.sign_transaction(sender.get_private_key())
    chain.add_transaction(tx)
    chain.mine_pending_transactions(miner.address)

    assert chain.is_chain_valid() is True
    assert chain.get_total_supply() == 100


def test_new_mempool_rejects_legacy_v1_transaction():
    chain = Blockchain()
    sender = Wallet()
    receiver = Wallet()

    tx = Transaction(
        version=Transaction.LEGACY_VERSION,
        sender=sender.address,
        receiver=receiver.address,
        amount=1,
        public_key=sender.get_public_key(),
        nonce=1
    )
    tx.sign_transaction(sender.get_private_key())

    with pytest.raises(Exception, match="protocol version"):
        chain.add_transaction(tx)


def test_reorg_recovers_valid_orphaned_transaction_to_mempool():
    chain = Blockchain()
    fork = Blockchain()
    sender = Wallet()
    receiver = Wallet()
    miner = Wallet()

    chain.mine_pending_transactions(sender.address)

    tx = Transaction(
        sender=sender.address,
        receiver=receiver.address,
        amount=5,
        public_key=sender.get_public_key(),
        nonce=chain.get_next_nonce(sender.address)
    )
    tx.sign_transaction(sender.get_private_key())
    chain.add_transaction(tx)
    chain.mine_pending_transactions(miner.address)

    fork.mine_pending_transactions(sender.address)
    fork.mine_pending_transactions(miner.address)
    fork.mine_pending_transactions(miner.address)

    incoming = [
        fork.block_to_dict(block)
        for block in fork.chain
    ]

    result = chain.replace_chain(incoming)

    assert result["replaced"] is True
    assert result["recovered_transactions"] == 1
    assert any(
        pending.get("txid") == tx.txid
        for pending in chain.pending_transactions
    )


def test_two_nodes_converge_on_chain_mempool_and_balance():
    node_a = Blockchain()
    node_b = Blockchain()
    sender = Wallet()
    receiver = Wallet()
    miner = Wallet()

    node_a.mine_pending_transactions(sender.address)

    initial_sync = node_b.replace_chain([
        node_a.block_to_dict(block)
        for block in node_a.chain
    ])
    assert initial_sync["replaced"] is True
    assert node_b.get_latest_block().hash == node_a.get_latest_block().hash

    tx = Transaction(
        sender=sender.address,
        receiver=receiver.address,
        amount=7,
        fee=0.25,
        public_key=sender.get_public_key(),
        nonce=node_a.get_next_nonce(sender.address)
    )
    tx.sign_transaction(sender.get_private_key())
    node_a.add_transaction(tx)

    mempool_sync = node_b.sync_mempool(node_a.pending_transactions)
    assert mempool_sync["accepted"] == 1

    node_b.mine_pending_transactions(miner.address)

    final_sync = node_a.replace_chain([
        node_b.block_to_dict(block)
        for block in node_b.chain
    ])

    assert final_sync["replaced"] is True
    assert node_a.get_latest_block().hash == node_b.get_latest_block().hash
    assert node_a.get_balance(receiver.address) == node_b.get_balance(receiver.address)
    assert node_a.get_balance(receiver.address) == 7


def test_stale_transaction_is_rejected_from_mempool():
    import time

    chain = Blockchain()
    sender = Wallet()
    receiver = Wallet()

    tx = Transaction(
        sender=sender.address,
        receiver=receiver.address,
        amount=1,
        public_key=sender.get_public_key(),
        nonce=1,
        timestamp=time.time() - chain.MEMPOOL_TX_TTL_SECONDS - 1
    )
    tx.sign_transaction(sender.get_private_key())

    with pytest.raises(Exception, match="too old"):
        chain.add_transaction(tx)


def test_new_blocks_use_integer_timestamp_and_merkle_commitment():
    chain = Blockchain()
    miner = Wallet()
    chain.mine_pending_transactions(miner.address)

    block = chain.get_latest_block()
    wire = chain.block_to_dict(block)

    assert block.version == Block.CURRENT_VERSION
    assert isinstance(wire["timestamp_ms"], int)
    assert len(wire["merkle_root"]) == 64
    assert "timestamp" not in wire
    assert chain.is_chain_valid() is True


def test_merkle_root_detects_transaction_tampering():
    chain = Blockchain()
    miner = Wallet()
    chain.mine_pending_transactions(miner.address)
    block = chain.get_latest_block()

    block.transactions[-1]["amount_atoms"] += 1

    assert chain.is_chain_valid() is False

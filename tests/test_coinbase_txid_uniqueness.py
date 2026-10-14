"""Regression: block reward transactions must stay unique per block.

Two consecutive blocks paid to the same miner address carry reward
transactions with the same receiver, amount, nonce and fee. Before the fix
the only distinguishing field was the reward transaction's own millisecond
timestamp, so when the second reward transaction was created in the same
millisecond as the first (a fast nonce search), both had an identical txid.
The honest node then produced a chain that its own validator rejects as a
duplicate-txid chain, which made a reorg test flaky on fast CI runners.

The clock is frozen here so the same-millisecond case is deterministic.
"""

import time

import pytest

from zyron.blockchain import Blockchain
from zyron.transaction import Transaction
from zyron.wallet import Wallet


@pytest.fixture
def frozen_clock(monkeypatch):
    frozen_ns = time.time_ns()
    monkeypatch.setattr(time, "time_ns", lambda: frozen_ns)
    return frozen_ns


def _reward_tx(block):
    reward = block.transactions[-1]
    assert reward["sender"] == "SYSTEM"
    return reward


def test_same_millisecond_blocks_to_same_miner_have_distinct_reward_txids(frozen_clock):
    chain = Blockchain()
    miner = Wallet()

    for _ in range(3):
        chain.mine_pending_transactions(miner.address)

    reward_txids = [_reward_tx(block)["txid"] for block in chain.chain[1:]]

    assert len(set(reward_txids)) == len(reward_txids)
    assert chain.is_chain_valid() is True


def test_reward_tx_timestamp_never_exceeds_block_timestamp(frozen_clock):
    chain = Blockchain()
    miner = Wallet()

    for _ in range(3):
        chain.mine_pending_transactions(miner.address)

    for block in chain.chain[1:]:
        reward = Transaction.from_dict(_reward_tx(block))
        assert reward.timestamp_ms <= block.timestamp_ms


def test_reorg_with_same_millisecond_blocks_recovers_orphaned_transaction(frozen_clock):
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

    result = chain.replace_chain([fork.block_to_dict(block) for block in fork.chain])

    assert result["replaced"] is True
    assert result["recovered_transactions"] == 1
    assert any(
        pending.get("txid") == tx.txid
        for pending in chain.pending_transactions
    )

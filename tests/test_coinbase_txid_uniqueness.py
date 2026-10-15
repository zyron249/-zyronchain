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


def test_block_timestamps_strictly_increase_past_float_roundtrip_boundary(monkeypatch):
    """R6-1011-L1 (round-6 independent retest of #1011): the next block's
    lower bound came from a float round-trip of the previous block's seconds
    timestamp. At 2147483648002 ms, int(float(ts) * 1000) loses a millisecond,
    so with a frozen clock the next block reused the previous timestamp and
    the reward txid repeated. The bound must use the integer milliseconds."""
    frozen_ns = 2_147_483_648_000 * 1_000_000
    monkeypatch.setattr(time, "time_ns", lambda: frozen_ns)
    monkeypatch.setattr(time, "time", lambda: frozen_ns / 1_000_000_000)
    chain = Blockchain()
    miner = Wallet()

    for _ in range(6):
        chain.mine_pending_transactions(miner.address)

    stamps = [block.timestamp_ms for block in chain.chain[1:]]
    assert all(later > earlier for earlier, later in zip(stamps, stamps[1:])), stamps
    reward_txids = [_reward_tx(block)["txid"] for block in chain.chain[1:]]
    assert len(set(reward_txids)) == len(reward_txids)
    assert chain.is_chain_valid() is True


@pytest.mark.parametrize("frozen_ms", [9_007_199_254_740_988, 9_007_199_254_740_992])
def test_chain_validation_orders_blocks_by_integer_milliseconds(monkeypatch, frozen_ms):
    """R6b-1015-L1 (round-6 independent retest of #1015): validation compared
    float seconds, and near 2**53 ms two consecutive integer timestamps map to
    the same float, so the node rejected its own honestly mined chain. Block
    order must be checked on the integer milliseconds."""
    frozen_ns = frozen_ms * 1_000_000
    monkeypatch.setattr(time, "time_ns", lambda: frozen_ns)
    monkeypatch.setattr(time, "time", lambda: frozen_ns / 1_000_000_000)
    chain = Blockchain()
    miner = Wallet()

    for _ in range(4):
        chain.mine_pending_transactions(miner.address)

    stamps = [block.timestamp_ms for block in chain.chain[1:]]
    assert all(later > earlier for earlier, later in zip(stamps, stamps[1:])), stamps
    assert chain.is_chain_valid() is True




def test_honest_mining_after_large_legacy_tip(monkeypatch):
    """R7-1017-L1: mining after a large legacy tip must still validate.

    Near 2**53, float seconds can stay equal when the integer millisecond
    advances by one. Validation must derive previous_ms the same way mining
    does when only the new block carries timestamp_ms.
    """
    from zyron.block import Block

    base_ms = (2**53) - 4
    legacy_seconds = base_ms / 1000
    # Keep wall-clock ahead of the legacy tip so future-time checks pass while
    # building the tip; freeze at the tip when mining the current block.
    monkeypatch.setattr(time, "time", lambda: legacy_seconds + 10_000)
    monkeypatch.setattr(time, "time_ns", lambda: int((legacy_seconds + 10_000) * 1_000_000_000))

    chain = Blockchain()
    miner = Wallet()
    receiver = "ZYN" + format(1, "040x")
    reward = Transaction(
        "SYSTEM",
        receiver,
        amount_atoms=50 * Transaction.ATOMS_PER_ZYN,
        fee_atoms=0,
        timestamp_ms=base_ms,
    )
    legacy = Block(
        len(chain.chain),
        [reward.to_dict()],
        chain.chain[-1].hash,
        difficulty=chain.calculate_expected_difficulty(chain.chain),
        version=Block.LEGACY_VERSION,
        timestamp=legacy_seconds,
        timestamp_ms=None,
    )
    del legacy.timestamp_ms
    legacy.mine()
    chain.chain.append(legacy)
    assert chain.is_chain_valid() is True

    monkeypatch.setattr(time, "time", lambda: legacy_seconds)
    monkeypatch.setattr(time, "time_ns", lambda: int(legacy_seconds * 1_000_000_000))
    chain.mine_pending_transactions(miner.address)
    current = chain.chain[-1]
    assert isinstance(current.timestamp_ms, int)
    assert current.timestamp_ms == round(legacy_seconds * 1000) + 1
    assert current.timestamp <= legacy.timestamp  # float seconds collide
    assert chain.is_chain_valid() is True, (
        f"honest legacy-to-current rejected: legacy={legacy.timestamp} "
        f"current_ms={current.timestamp_ms} current={current.timestamp}"
    )


def test_current_block_float_timestamp_must_match_integer_milliseconds(monkeypatch):
    """R7b-1020-L1: a current-version block's float timestamp is derived from
    timestamp_ms and is not hashed. Validation orders current blocks on
    timestamp_ms, so an in-memory block whose float seconds disagree with its
    integer milliseconds must be rejected rather than validated on either.
    """
    from zyron.block import Block

    legacy_seconds = 2147483648.0
    base_ms = round(legacy_seconds * 1000)
    monkeypatch.setattr(time, "time", lambda: legacy_seconds + 10)
    monkeypatch.setattr(time, "time_ns", lambda: int((legacy_seconds + 10) * 1_000_000_000))

    chain = Blockchain()
    legacy_reward = Transaction(
        "SYSTEM",
        "ZYN" + format(1, "040x"),
        amount_atoms=50 * Transaction.ATOMS_PER_ZYN,
        fee_atoms=0,
        timestamp_ms=base_ms - 5,
    )
    legacy = Block(
        len(chain.chain),
        [legacy_reward.to_dict()],
        chain.chain[-1].hash,
        difficulty=chain.calculate_expected_difficulty(chain.chain),
        version=Block.LEGACY_VERSION,
        timestamp=legacy_seconds,
        timestamp_ms=None,
    )
    del legacy.timestamp_ms
    legacy.mine()
    chain.chain.append(legacy)

    current_reward = Transaction(
        "SYSTEM",
        "ZYN" + format(2, "040x"),
        amount_atoms=50 * Transaction.ATOMS_PER_ZYN,
        fee_atoms=0,
        timestamp_ms=base_ms - 1000,
    )
    current = Block(
        len(chain.chain),
        [current_reward.to_dict()],
        legacy.hash,
        difficulty=chain.calculate_expected_difficulty(chain.chain),
        version=Block.CURRENT_VERSION,
        timestamp_ms=base_ms + 1,
    )
    current.mine()
    chain.chain.append(current)
    assert chain.is_chain_valid() is True

    original_hash = current.hash
    current.timestamp = legacy_seconds - 1  # older than its predecessor
    assert current.calculate_hash() == original_hash
    assert chain.is_chain_valid() is False

    current.timestamp = (base_ms + 1) / 1000
    assert chain.is_chain_valid() is True

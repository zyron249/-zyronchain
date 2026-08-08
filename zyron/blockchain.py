import re
import time
import math
import json
import threading
from functools import wraps
from zyron.block import Block
from zyron.transaction import Transaction
from zyron.storage import BlockchainStorage
from zyron.wallet import address_from_public_key


def synchronized(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return wrapped


class Blockchain:
    GENESIS_TIMESTAMP = 1704067200
    MAX_FUTURE_BLOCK_TIME = 120
    MAX_BLOCK_TRANSACTIONS = 1000
    MAX_BLOCK_SERIALIZED_BYTES = 1_000_000
    MAX_MEMPOOL_SIZE = 5000
    MEMPOOL_TX_TTL_SECONDS = 3600
    MAX_TX_FUTURE_SECONDS = 120
    V2_BLOCK_FIELDS = frozenset({
        "version", "index", "timestamp_ms", "transactions", "merkle_root",
        "previous_hash", "difficulty", "nonce", "hash"
    })

    def __init__(self):
        self._lock = threading.RLock()
        self.storage = BlockchainStorage()
        self.chain = [self.create_genesis_block()]

        self.difficulty = 4
        self.min_difficulty = 2
        self.max_difficulty = 8
        self.target_block_time = 30
        self.difficulty_adjustment_interval = 5

        self.pending_transactions = []
        self.max_supply = 50_000_000
        self.initial_mining_reward = 50
        self.max_supply_atoms = self.max_supply * Transaction.ATOMS_PER_ZYN
        self.initial_mining_reward_atoms = self.initial_mining_reward * Transaction.ATOMS_PER_ZYN
        self.halving_interval = 100_000
        self.mining_reward = self.get_current_reward()

        self.load_chain()

    def is_valid_address(self, address):
        if not isinstance(address, str):
            return False
        return re.fullmatch(r"ZYN[a-fA-F0-9]{40}", address) is not None

    def transaction_public_key_matches_sender(self, transaction):
        if transaction.sender == "SYSTEM":
            return True

        if not transaction.public_key:
            return False

        try:
            return address_from_public_key(transaction.public_key) == transaction.sender
        except Exception:
            return False

    def create_genesis_block(self):
        return Block(
            index=0,
            transactions=["Genesis Block"],
            previous_hash="0",
            difficulty=4,
            timestamp=self.GENESIS_TIMESTAMP,
            version=Block.LEGACY_VERSION
        )

    def get_latest_block(self):
        return self.chain[-1]

    def get_block_work(self, block):
        return 16 ** int(block.difficulty)

    def get_chain_work(self, chain_to_measure=None):
        chain_to_measure = chain_to_measure if chain_to_measure is not None else self.chain
        return sum(self.get_block_work(block) for block in chain_to_measure)

    def block_to_dict(self, block):
        data = {
            "index": block.index,
            "transactions": block.transactions,
            "previous_hash": block.previous_hash,
            "difficulty": block.difficulty,
            "nonce": block.nonce,
            "hash": block.hash
        }
        if block.version == Block.CURRENT_VERSION:
            data.update({
                "version": block.version,
                "timestamp_ms": block.timestamp_ms,
                "merkle_root": block.merkle_root
            })
        else:
            data["timestamp"] = block.timestamp
        return data

    def dict_to_block(self, block_data):
        if not isinstance(block_data, dict):
            raise ValueError("Block must be an object")
        version = block_data.get("version", Block.LEGACY_VERSION)
        if version == Block.CURRENT_VERSION:
            unknown = set(block_data) - self.V2_BLOCK_FIELDS
            missing = self.V2_BLOCK_FIELDS - set(block_data)
            if unknown:
                raise ValueError(f"Unknown v2 block fields: {', '.join(sorted(unknown))}")
            if missing:
                raise ValueError(f"Missing v2 block fields: {', '.join(sorted(missing))}")
        block = Block(
            block_data["index"],
            block_data["transactions"],
            block_data["previous_hash"],
            block_data.get("difficulty", 4),
            timestamp=block_data.get("timestamp"),
            version=version,
            timestamp_ms=block_data.get("timestamp_ms"),
            merkle_root=block_data.get("merkle_root")
        )
        block.nonce = block_data["nonce"]
        block.hash = block_data["hash"]
        return block

    def save_chain(self):
        self.storage.save_chain([self.block_to_dict(block) for block in self.chain])

    def load_chain(self):
        data = self.storage.load_chain()
        if not data:
            return

        try:
            candidate_chain = [
                self.dict_to_block(block_data)
                for block_data in data
            ]
        except Exception as error:
            print("Stored chain rejected:", str(error))
            return

        if not self.is_valid_chain(candidate_chain):
            print("Stored chain rejected: consensus validation failed")
            return

        self.chain = candidate_chain
        self.difficulty = self.get_latest_block().difficulty
        self.mining_reward = self.get_current_reward()

    def calculate_expected_difficulty(self, chain_context):
        if not chain_context:
            return self.difficulty

        current_height = len(chain_context)

        if current_height < self.difficulty_adjustment_interval + 1:
            return chain_context[-1].difficulty

        if current_height % self.difficulty_adjustment_interval != 0:
            return chain_context[-1].difficulty

        latest_block = chain_context[-1]
        previous_adjustment_block = chain_context[-self.difficulty_adjustment_interval]

        actual_time = latest_block.timestamp - previous_adjustment_block.timestamp
        expected_time = self.target_block_time * self.difficulty_adjustment_interval

        new_difficulty = latest_block.difficulty

        if actual_time < expected_time / 2:
            new_difficulty += 1
        elif actual_time > expected_time * 2:
            new_difficulty -= 1

        return max(self.min_difficulty, min(new_difficulty, self.max_difficulty))

    def adjust_difficulty(self):
        self.difficulty = self.calculate_expected_difficulty(self.chain)
        return self.difficulty

    def get_network_info(self):
        return {
            "difficulty": self.difficulty,
            "min_difficulty": self.min_difficulty,
            "max_difficulty": self.max_difficulty,
            "target_block_time": self.target_block_time,
            "difficulty_adjustment_interval": self.difficulty_adjustment_interval,
            "current_block_height": len(self.chain) - 1,
            "cumulative_work": self.get_chain_work(),
            "max_mempool_size": self.MAX_MEMPOOL_SIZE,
            "mempool_ttl_seconds": self.MEMPOOL_TX_TTL_SECONDS
        }

    def get_block_subsidy(self, block_index):
        return self.get_block_subsidy_atoms(block_index) / Transaction.ATOMS_PER_ZYN

    def get_block_subsidy_atoms(self, block_index):
        halvings = int(block_index) // self.halving_interval
        if halvings >= self.initial_mining_reward_atoms.bit_length():
            return 0
        return self.initial_mining_reward_atoms >> halvings

    @staticmethod
    def transaction_amount_atoms(tx_data):
        return Transaction.amount_atoms_from_dict(tx_data)

    @staticmethod
    def transaction_fee_atoms(tx_data):
        return Transaction.fee_atoms_from_dict(tx_data)

    @staticmethod
    def transaction_timestamp(tx_data):
        return Transaction.timestamp_seconds_from_dict(tx_data)

    @staticmethod
    def atoms_to_zyn(atoms):
        return atoms / Transaction.ATOMS_PER_ZYN

    def transaction_display_values(self, tx_data):
        return {
            "amount": self.atoms_to_zyn(self.transaction_amount_atoms(tx_data)),
            "fee": self.atoms_to_zyn(self.transaction_fee_atoms(tx_data)),
            "timestamp": self.transaction_timestamp(tx_data)
        }

    def get_total_supply_atoms(self):
        total = 0

        for block in self.chain[1:]:
            block_fees = 0
            system_amount = 0

            for tx in block.transactions:
                if not isinstance(tx, dict):
                    continue

                if tx.get("sender") == "SYSTEM":
                    system_amount += self.transaction_amount_atoms(tx)
                else:
                    block_fees += self.transaction_fee_atoms(tx)

            total += max(system_amount - block_fees, 0)

        return min(total, self.max_supply_atoms)

    def get_total_supply(self):
        return self.atoms_to_zyn(self.get_total_supply_atoms())

    def get_current_reward(self):
        return self.get_block_subsidy(len(self.chain))

    def get_remaining_supply(self):
        return self.atoms_to_zyn(self.get_remaining_supply_atoms())

    def get_remaining_supply_atoms(self):
        return max(self.max_supply_atoms - self.get_total_supply_atoms(), 0)

    def get_supply_info(self):
        return {
            "max_supply": self.max_supply,
            "total_supply": self.get_total_supply(),
            "remaining_supply": self.get_remaining_supply(),
            "current_reward": self.get_current_reward(),
            "halving_interval": self.halving_interval,
            "next_halving_block": ((len(self.chain) // self.halving_interval) + 1) * self.halving_interval,
            "current_block_height": len(self.chain) - 1
        }

    def get_nonce(self, address):
        nonce = 0

        for block in self.chain:
            for tx in block.transactions:
                if isinstance(tx, dict) and tx.get("sender") == address:
                    nonce = max(nonce, int(tx.get("nonce", 0)))

        self.cleanup_mempool()

        for tx in self.pending_transactions:
            if isinstance(tx, dict) and tx.get("sender") == address:
                nonce = max(nonce, int(tx.get("nonce", 0)))

        return nonce

    def get_confirmed_nonce(self, address):
        nonce = 0

        for block in self.chain:
            for tx in block.transactions:
                if isinstance(tx, dict) and tx.get("sender") == address:
                    nonce = max(nonce, int(tx.get("nonce", 0)))

        return nonce

    def get_next_nonce(self, address):
        return self.get_nonce(address) + 1

    def get_nonce_before_block(self, address, block_index, chain_to_search=None):
        nonce = 0
        chain_to_search = chain_to_search if chain_to_search is not None else self.chain

        for block in chain_to_search:
            if block.index >= block_index:
                break

            for tx in block.transactions:
                if isinstance(tx, dict) and tx.get("sender") == address:
                    nonce = max(nonce, int(tx.get("nonce", 0)))

        return nonce

    def has_pending_nonce_conflict(self, sender, nonce):
        self.cleanup_mempool()

        for tx in self.pending_transactions:
            if not isinstance(tx, dict):
                continue

            if tx.get("sender") == sender and int(tx.get("nonce", -1)) == int(nonce):
                return True

        return False

    @synchronized
    def cleanup_mempool(self):
        now = time.time()
        cleaned_transactions = []

        for tx in self.pending_transactions:
            if not isinstance(tx, dict):
                continue

            if tx.get("sender") == "SYSTEM":
                continue

            try:
                tx_timestamp = self.transaction_timestamp(tx)
            except (KeyError, TypeError, ValueError, OverflowError):
                continue

            if now - tx_timestamp <= self.MEMPOOL_TX_TTL_SECONDS:
                cleaned_transactions.append(tx)

        self.pending_transactions = cleaned_transactions

    def get_min_mempool_fee(self):
        self.cleanup_mempool()

        if len(self.pending_transactions) < self.MAX_MEMPOOL_SIZE:
            return 0

        fees = [
            self.transaction_fee_atoms(tx)
            for tx in self.pending_transactions
            if isinstance(tx, dict) and tx.get("sender") != "SYSTEM"
        ]

        if not fees:
            return 0

        return self.atoms_to_zyn(min(fees))

    @synchronized
    def enforce_mempool_limit(self):
        self.cleanup_mempool()

        normal_transactions = [
            tx for tx in self.pending_transactions
            if isinstance(tx, dict) and tx.get("sender") != "SYSTEM"
        ]

        normal_transactions.sort(
            key=lambda tx: (
                self.transaction_fee_atoms(tx),
                self.transaction_timestamp(tx)
            ),
            reverse=True
        )

        self.pending_transactions = normal_transactions[:self.MAX_MEMPOOL_SIZE]

    def get_pending_spent_amount(self, address):
        self.cleanup_mempool()
        total_atoms = 0

        for tx in self.pending_transactions:
            if isinstance(tx, dict) and tx.get("sender") == address:
                total_atoms += self.transaction_amount_atoms(tx) + self.transaction_fee_atoms(tx)

        return self.atoms_to_zyn(total_atoms)

    def get_available_balance(self, address):
        return self.get_balance(address) - self.get_pending_spent_amount(address)

    def get_pending_spent_atoms(self, address):
        self.cleanup_mempool()
        return sum(
            self.transaction_amount_atoms(tx) + self.transaction_fee_atoms(tx)
            for tx in self.pending_transactions
            if isinstance(tx, dict) and tx.get("sender") == address
        )

    def get_available_balance_atoms(self, address):
        return self.get_balance_atoms(address) - self.get_pending_spent_atoms(address)

    def get_sorted_pending_transactions(self):
        self.cleanup_mempool()

        normal_transactions = [
            tx for tx in self.pending_transactions
            if isinstance(tx, dict) and tx.get("sender") != "SYSTEM"
        ]

        selected = []
        selected_txids = set()
        working_nonces = {}
        working_spent = {}

        for tx in normal_transactions:
            sender = tx.get("sender")
            if sender and sender not in working_nonces:
                working_nonces[sender] = self.get_confirmed_nonce(sender)
                working_spent[sender] = 0

        while len(selected) < self.MAX_BLOCK_TRANSACTIONS:
            candidates = []

            for tx in normal_transactions:
                txid = tx.get("txid")

                if txid in selected_txids:
                    continue

                sender = tx.get("sender")
                if not sender:
                    continue

                expected_nonce = working_nonces.get(sender, self.get_confirmed_nonce(sender)) + 1

                if int(tx.get("nonce", -1)) != expected_nonce:
                    continue

                total_cost = self.transaction_amount_atoms(tx) + self.transaction_fee_atoms(tx)
                available_balance = self.get_balance_atoms(sender) - working_spent.get(sender, 0)

                if available_balance < total_cost:
                    continue

                candidates.append(tx)

            if not candidates:
                break

            candidates.sort(
                key=lambda tx: (
                    self.transaction_fee_atoms(tx),
                    self.transaction_timestamp(tx)
                ),
                reverse=True
            )

            selected_tx = candidates[0]
            selected.append(selected_tx)
            selected_txids.add(selected_tx.get("txid"))

            sender = selected_tx.get("sender")
            working_nonces[sender] = int(selected_tx.get("nonce", working_nonces.get(sender, 0) + 1))
            working_spent[sender] = (
                working_spent.get(sender, 0)
                + self.transaction_amount_atoms(selected_tx)
                + self.transaction_fee_atoms(selected_tx)
            )

        return selected

    def get_block(self, index):
        try:
            index = int(index)
        except ValueError:
            return {"found": False, "error": "Invalid block index"}

        for block in self.chain:
            if block.index == index:
                return {"found": True, "block": self.block_to_dict(block)}

        return {"found": False, "error": "Block not found", "index": index}

    def is_valid_genesis_block(self, genesis_block):
        expected_genesis = self.create_genesis_block()

        return (
            genesis_block.index == expected_genesis.index
            and genesis_block.timestamp == expected_genesis.timestamp
            and genesis_block.transactions == expected_genesis.transactions
            and genesis_block.previous_hash == expected_genesis.previous_hash
            and genesis_block.difficulty == expected_genesis.difficulty
            and genesis_block.hash == expected_genesis.hash
        )

    def is_valid_chain(self, chain_to_validate):
        if not chain_to_validate:
            return False

        if not self.is_valid_genesis_block(chain_to_validate[0]):
            return False

        validated_supply_atoms = 0
        seen_chain_txids = set()

        for i in range(1, len(chain_to_validate)):
            current = chain_to_validate[i]
            previous = chain_to_validate[i - 1]

            if not isinstance(current.index, int) or isinstance(current.index, bool):
                return False

            if current.version not in (Block.LEGACY_VERSION, Block.CURRENT_VERSION):
                return False

            if not isinstance(current.difficulty, int) or isinstance(current.difficulty, bool):
                return False

            if not isinstance(current.nonce, int) or isinstance(current.nonce, bool) or current.nonce < 0:
                return False

            if not isinstance(current.transactions, list):
                return False

            try:
                current_timestamp = float(current.timestamp)
            except (TypeError, ValueError, OverflowError):
                return False

            if not math.isfinite(current_timestamp):
                return False

            expected_difficulty = self.calculate_expected_difficulty(
                chain_to_validate[:i]
            )
            target = "0" * current.difficulty

            if current.index != previous.index + 1:
                return False

            if current.difficulty != expected_difficulty:
                return False

            if abs(int(current.difficulty) - int(previous.difficulty)) > 1:
                return False

            if current.difficulty < self.min_difficulty:
                return False

            if current.difficulty > self.max_difficulty:
                return False

            if current.timestamp <= previous.timestamp:
                return False

            if current.timestamp > time.time() + self.MAX_FUTURE_BLOCK_TIME:
                return False

            if len(current.transactions) > self.MAX_BLOCK_TRANSACTIONS + 1:
                return False

            if current.version == Block.CURRENT_VERSION:
                if not isinstance(current.timestamp_ms, int) or isinstance(current.timestamp_ms, bool):
                    return False
                if current.merkle_root != current.calculate_merkle_root():
                    return False

            try:
                serialized_block = json.dumps(
                    self.block_to_dict(current),
                    sort_keys=True,
                    separators=(",", ":"),
                    ensure_ascii=False
                ).encode("utf-8")
            except (TypeError, ValueError, OverflowError):
                return False

            if len(serialized_block) > self.MAX_BLOCK_SERIALIZED_BYTES:
                return False

            if current.hash != current.calculate_hash():
                return False

            if current.previous_hash != previous.hash:
                return False

            if not current.hash.startswith(target):
                return False

            parsed_transactions = []
            system_transactions = []
            block_fees_atoms = 0

            for tx_data in current.transactions:
                if not isinstance(tx_data, dict):
                    return False

                try:
                    tx = Transaction.from_dict(tx_data)
                except (KeyError, TypeError, ValueError, OverflowError):
                    return False

                if not tx.txid or tx.txid in seen_chain_txids:
                    return False

                seen_chain_txids.add(tx.txid)

                if not self.is_valid_address(tx.receiver):
                    return False

                if not tx.is_valid():
                    return False

                if float(tx.timestamp) > float(current.timestamp):
                    return False

                if tx.sender == "SYSTEM":
                    system_transactions.append(tx)
                else:
                    if not self.is_valid_address(tx.sender):
                        return False

                    if not self.transaction_public_key_matches_sender(tx):
                        return False

                    block_fees_atoms += tx.fee_atoms_value()

                parsed_transactions.append(tx)

            if block_fees_atoms < 0:
                return False

            if len(system_transactions) > 1:
                return False

            if system_transactions and parsed_transactions[-1].sender != "SYSTEM":
                return False

            block_subsidy_atoms = self.get_block_subsidy_atoms(current.index)
            remaining_supply_atoms = max(self.max_supply_atoms - validated_supply_atoms, 0)
            minted_subsidy_atoms = min(block_subsidy_atoms, remaining_supply_atoms)
            expected_miner_payment_atoms = minted_subsidy_atoms + block_fees_atoms

            if expected_miner_payment_atoms > 0:
                if len(system_transactions) != 1:
                    return False

                reward_tx = system_transactions[0]

                if reward_tx.amount_atoms_value() != expected_miner_payment_atoms:
                    return False
            elif system_transactions:
                return False

            expected_nonces = {}
            spent_in_block = {}

            for tx in parsed_transactions:
                if tx.sender == "SYSTEM":
                    continue

                previous_nonce = expected_nonces.get(
                    tx.sender,
                    self.get_nonce_before_block(
                        tx.sender,
                        current.index,
                        chain_to_validate
                    )
                )

                if tx.nonce != previous_nonce + 1:
                    return False

                total_cost_atoms = tx.amount_atoms_value() + tx.fee_atoms_value()
                balance_before_block_atoms = self.get_balance_atoms_before_block(
                    tx.sender,
                    current.index,
                    chain_to_validate
                )

                if spent_in_block.get(tx.sender, 0) + total_cost_atoms > balance_before_block_atoms:
                    return False

                spent_in_block[tx.sender] = (
                    spent_in_block.get(tx.sender, 0) + total_cost_atoms
                )
                expected_nonces[tx.sender] = tx.nonce

            validated_supply_atoms += minted_subsidy_atoms

        return True

    def get_balance_before_block(self, address, block_index, chain_to_search=None):
        return self.atoms_to_zyn(
            self.get_balance_atoms_before_block(address, block_index, chain_to_search)
        )

    def get_balance_atoms_before_block(self, address, block_index, chain_to_search=None):
        balance_atoms = 0
        chain_to_search = chain_to_search if chain_to_search is not None else self.chain

        for block in chain_to_search:
            if block.index >= block_index:
                break

            for tx in block.transactions:
                if not isinstance(tx, dict):
                    continue

                amount_atoms = self.transaction_amount_atoms(tx)
                fee_atoms = self.transaction_fee_atoms(tx)

                if tx.get("sender") == address:
                    balance_atoms -= amount_atoms
                    balance_atoms -= fee_atoms

                if tx.get("receiver") == address:
                    balance_atoms += amount_atoms

        return balance_atoms

    @synchronized
    def replace_chain(self, new_chain_data):
        if not new_chain_data:
            return {"replaced": False, "reason": "No chain data provided"}

        try:
            new_chain = [self.dict_to_block(block_data) for block_data in new_chain_data]
        except (KeyError, TypeError, ValueError, OverflowError):
            return {"replaced": False, "reason": "Incoming chain is invalid"}

        if not self.is_valid_chain(new_chain):
            return {"replaced": False, "reason": "Incoming chain is invalid"}

        current_work = self.get_chain_work(self.chain)
        incoming_work = self.get_chain_work(new_chain)

        if incoming_work <= current_work:
            return {
                "replaced": False,
                "reason": "Incoming chain does not have more cumulative work",
                "current_work": current_work,
                "incoming_work": incoming_work
            }

        previous_chain = self.chain
        previous_pending = list(self.pending_transactions)

        confirmed_txids = {
            tx.get("txid")
            for block in new_chain
            for tx in block.transactions
            if isinstance(tx, dict) and tx.get("txid")
        }

        orphaned_transactions = []
        for block in previous_chain[1:]:
            for tx in block.transactions:
                if (
                    isinstance(tx, dict)
                    and tx.get("sender") != "SYSTEM"
                    and tx.get("txid") not in confirmed_txids
                ):
                    orphaned_transactions.append(tx)

        self.chain = new_chain
        self.pending_transactions = []
        self.difficulty = self.get_latest_block().difficulty
        self.mining_reward = self.get_current_reward()

        recovered = 0
        dropped = 0
        recovery_candidates = previous_pending + orphaned_transactions

        for tx_data in recovery_candidates:
            result = self.add_transaction_from_dict(tx_data)
            if result.get("accepted"):
                recovered += 1
            else:
                dropped += 1

        self.save_chain()

        return {
            "replaced": True,
            "new_length": len(self.chain),
            "current_work": current_work,
            "incoming_work": incoming_work,
            "recovered_transactions": recovered,
            "dropped_transactions": dropped
        }

    def has_transaction(self, txid):
        for block in self.chain:
            for tx in block.transactions:
                if isinstance(tx, dict) and tx.get("txid") == txid:
                    return True

        self.cleanup_mempool()

        for tx in self.pending_transactions:
            if isinstance(tx, dict) and tx.get("txid") == txid:
                return True

        return False

    @synchronized
    def add_transaction_from_dict(self, tx_data):
        if not isinstance(tx_data, dict):
            return {"accepted": False, "reason": "Invalid transaction data"}

        txid = tx_data.get("txid")

        if not txid:
            return {"accepted": False, "reason": "Missing txid"}

        if self.has_transaction(txid):
            return {"accepted": False, "reason": "Transaction already exists", "txid": txid}

        try:
            tx = Transaction.from_dict(tx_data)
            accepted_txid = self.add_transaction(tx)
            return {"accepted": True, "txid": accepted_txid}
        except Exception as error:
            return {"accepted": False, "reason": str(error), "txid": txid}

    @synchronized
    def sync_mempool(self, remote_transactions):
        if not isinstance(remote_transactions, list):
            return {
                "accepted": 0,
                "rejected": 0,
                "results": [],
                "reason": "Remote transactions must be a list"
            }

        self.cleanup_mempool()

        accepted = 0
        rejected = 0
        results = []

        for tx_data in remote_transactions:
            result = self.add_transaction_from_dict(tx_data)
            results.append(result)

            if result.get("accepted"):
                accepted += 1
            else:
                rejected += 1

        self.enforce_mempool_limit()

        return {
            "accepted": accepted,
            "rejected": rejected,
            "pending_transactions": len(self.pending_transactions),
            "results": results
        }

    @synchronized
    def add_transaction(self, transaction):
        self.cleanup_mempool()

        if transaction.sender == "SYSTEM":
            raise Exception("SYSTEM transactions can only be created while mining")

        if transaction.version != Transaction.CURRENT_VERSION:
            raise Exception(
                f"New transactions must use protocol version {Transaction.CURRENT_VERSION}"
            )

        if not transaction.is_valid():
            raise Exception("Invalid transaction signature")

        now = time.time()
        transaction_timestamp = float(transaction.timestamp)

        if transaction_timestamp > now + self.MAX_TX_FUTURE_SECONDS:
            raise Exception("Transaction timestamp is too far in the future")

        if now - transaction_timestamp > self.MEMPOOL_TX_TTL_SECONDS:
            raise Exception("Transaction is too old for the mempool")

        if not self.transaction_public_key_matches_sender(transaction):
            raise Exception("Public key does not match sender address")

        if self.has_transaction(transaction.txid):
            raise Exception("Transaction already exists")

        if transaction.sender == "SYSTEM":
            if not self.is_valid_address(transaction.receiver):
                raise Exception("Invalid receiver address")

            self.pending_transactions.append(transaction.to_dict())
            self.enforce_mempool_limit()
            return transaction.txid

        if not self.is_valid_address(transaction.sender):
            raise Exception("Invalid sender address")

        if not self.is_valid_address(transaction.receiver):
            raise Exception("Invalid receiver address")

        if transaction.amount <= 0:
            raise Exception("Transaction amount must be greater than zero")

        if transaction.fee < 0:
            raise Exception("Transaction fee cannot be negative")

        min_fee = self.get_min_mempool_fee()

        if len(self.pending_transactions) >= self.MAX_MEMPOOL_SIZE and transaction.fee <= min_fee:
            raise Exception(f"Mempool full. Transaction fee must be greater than {min_fee}")

        if self.has_pending_nonce_conflict(transaction.sender, transaction.nonce):
            raise Exception("Double-spend rejected: sender already has a pending transaction with this nonce")

        expected_nonce = self.get_next_nonce(transaction.sender)

        if transaction.nonce != expected_nonce:
            raise Exception(f"Invalid nonce. Expected {expected_nonce}")

        total_cost_atoms = transaction.amount_atoms_value() + transaction.fee_atoms_value()

        if self.get_available_balance_atoms(transaction.sender) < total_cost_atoms:
            raise Exception("Double-spend rejected: Insufficient balance after pending transactions")

        self.pending_transactions.append(transaction.to_dict())
        self.enforce_mempool_limit()
        return transaction.txid

    @synchronized
    def mine_pending_transactions(self, miner_address):
        if not self.is_valid_address(miner_address):
            raise Exception("Invalid miner address")

        self.cleanup_mempool()
        selected_transactions = self.get_sorted_pending_transactions()

        current_reward_atoms = self.get_block_subsidy_atoms(len(self.chain))
        remaining_supply_atoms = self.get_remaining_supply_atoms()

        if remaining_supply_atoms <= 0:
            current_reward_atoms = 0

        if current_reward_atoms > remaining_supply_atoms:
            current_reward_atoms = remaining_supply_atoms

        total_fees_atoms = 0

        for tx in selected_transactions:
            total_fees_atoms += self.transaction_fee_atoms(tx)

        block_transactions = list(selected_transactions)
        miner_payment_atoms = current_reward_atoms + total_fees_atoms

        if miner_payment_atoms > 0:
            reward_tx = Transaction(
                "SYSTEM",
                miner_address,
                amount_atoms=miner_payment_atoms,
                fee_atoms=0,
                nonce=0
            )
            block_transactions.append(reward_tx.to_dict())

        new_difficulty = self.calculate_expected_difficulty(self.chain)
        self.difficulty = new_difficulty

        latest_block = self.get_latest_block()
        block_timestamp_ms = max(
            time.time_ns() // 1_000_000,
            int(float(latest_block.timestamp) * 1000) + 1
        )

        block = Block(
            len(self.chain),
            block_transactions,
            latest_block.hash,
            new_difficulty,
            timestamp_ms=block_timestamp_ms,
            version=Block.CURRENT_VERSION
        )

        block.mine()
        self.chain.append(block)
        self.mining_reward = self.get_current_reward()
        self.save_chain()

        selected_txids = {
            tx.get("txid")
            for tx in selected_transactions
            if isinstance(tx, dict)
        }

        self.pending_transactions = [
            tx for tx in self.pending_transactions
            if not isinstance(tx, dict) or tx.get("txid") not in selected_txids
        ]

        self.enforce_mempool_limit()

    def get_balance(self, address):
        return self.atoms_to_zyn(self.get_balance_atoms(address))

    def get_balance_atoms(self, address):
        balance_atoms = 0

        for block in self.chain:
            for tx in block.transactions:
                if isinstance(tx, dict):
                    amount_atoms = self.transaction_amount_atoms(tx)
                    fee_atoms = self.transaction_fee_atoms(tx)

                    if tx.get("sender") == address:
                        balance_atoms -= amount_atoms
                        balance_atoms -= fee_atoms

                    if tx.get("receiver") == address:
                        balance_atoms += amount_atoms

        return balance_atoms

    def get_transaction(self, txid):
        self.cleanup_mempool()

        for block in self.chain:
            for tx in block.transactions:
                if isinstance(tx, dict) and tx.get("txid") == txid:
                    return {"found": True, "block_index": block.index, "transaction": tx}

        for tx in self.pending_transactions:
            if isinstance(tx, dict) and tx.get("txid") == txid:
                return {"found": True, "block_index": None, "status": "pending", "transaction": tx}

        return {"found": False, "txid": txid}

    def get_address_transactions(self, address):
        transactions = []

        for block in self.chain:
            for tx in block.transactions:
                if not isinstance(tx, dict):
                    continue

                if tx.get("sender") == address or tx.get("receiver") == address:
                    display = self.transaction_display_values(tx)
                    transactions.append({
                        "block_index": block.index,
                        "txid": tx.get("txid"),
                        "sender": tx.get("sender"),
                        "receiver": tx.get("receiver"),
                        "amount": display["amount"],
                        "fee": display["fee"],
                        "nonce": tx.get("nonce", 0),
                        "timestamp": display["timestamp"]
                    })

        transactions.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
        return transactions

    def get_total_transaction_count(self):
        count = 0

        for block in self.chain:
            for tx in block.transactions:
                if isinstance(tx, dict):
                    count += 1

        return count

    def get_all_addresses(self):
        addresses = set()

        for block in self.chain:
            for tx in block.transactions:
                if not isinstance(tx, dict):
                    continue

                sender = tx.get("sender")
                receiver = tx.get("receiver")

                if sender and sender != "SYSTEM" and self.is_valid_address(sender):
                    addresses.add(sender)

                if receiver and self.is_valid_address(receiver):
                    addresses.add(receiver)

        return list(addresses)

    def get_rich_list(self, limit=100):
        rich_list = []

        for address in self.get_all_addresses():
            balance = self.get_balance(address)

            if balance > 0:
                rich_list.append({"address": address, "balance": balance})

        rich_list.sort(key=lambda x: x["balance"], reverse=True)
        return rich_list[:limit]

    def get_average_block_time(self):
        if len(self.chain) < 2:
            return 0

        first_block = self.chain[0]
        latest_block = self.chain[-1]
        total_time = latest_block.timestamp - first_block.timestamp
        block_count = len(self.chain) - 1

        if block_count <= 0:
            return 0

        return round(total_time / block_count, 2)

    def get_latest_transactions(self, limit=10):
        transactions = []

        for block in self.chain:
            for tx in block.transactions:
                if not isinstance(tx, dict):
                    continue

                sender = tx.get("sender")
                receiver = tx.get("receiver")

                if sender != "SYSTEM" and not self.is_valid_address(sender):
                    continue

                if not self.is_valid_address(receiver):
                    continue

                display = self.transaction_display_values(tx)
                transactions.append({
                    "block_index": block.index,
                    "txid": tx.get("txid"),
                    "sender": sender,
                    "receiver": receiver,
                    "amount": display["amount"],
                    "fee": display["fee"],
                    "nonce": tx.get("nonce", 0),
                    "timestamp": display["timestamp"]
                })

        transactions.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
        return transactions[:limit]

    def get_mempool_info(self):
        self.cleanup_mempool()

        return {
            "count": len(self.pending_transactions),
            "max_size": self.MAX_MEMPOOL_SIZE,
            "ttl_seconds": self.MEMPOOL_TX_TTL_SECONDS,
            "min_fee": self.get_min_mempool_fee(),
            "pending_transactions": self.pending_transactions
        }

    def get_mining_leaderboard(self, limit=100):
        miners = {}

        for block in self.chain:
            for tx in block.transactions:
                if not isinstance(tx, dict):
                    continue

                if tx.get("sender") == "SYSTEM":
                    miner = tx.get("receiver")
                    amount = self.atoms_to_zyn(self.transaction_amount_atoms(tx))

                    if not self.is_valid_address(miner):
                        continue

                    if miner not in miners:
                        miners[miner] = {
                            "address": miner,
                            "blocks_mined": 0,
                            "total_rewards": 0
                        }

                    miners[miner]["blocks_mined"] += 1
                    miners[miner]["total_rewards"] += amount

        leaderboard = list(miners.values())
        leaderboard.sort(key=lambda x: x["total_rewards"], reverse=True)
        return leaderboard[:limit]

    def get_explorer_summary(self):
        latest_block = self.get_latest_block()
        self.cleanup_mempool()

        return {
            "name": "ZyronChain",
            "blocks": len(self.chain),
            "current_block_height": len(self.chain) - 1,
            "latest_block_hash": latest_block.hash,
            "difficulty": self.difficulty,
            "cumulative_work": self.get_chain_work(),
            "pending_transactions": len(self.pending_transactions),
            "max_mempool_size": self.MAX_MEMPOOL_SIZE,
            "mempool_ttl_seconds": self.MEMPOOL_TX_TTL_SECONDS,
            "total_transactions": self.get_total_transaction_count(),
            "total_addresses": len(self.get_all_addresses()),
            "average_block_time_seconds": self.get_average_block_time(),
            "chain_valid": self.is_chain_valid(),
            "supply": self.get_supply_info(),
            "network": self.get_network_info(),
            "latest_transactions": self.get_latest_transactions(10),
            "rich_list": self.get_rich_list(10),
            "mining_leaderboard": self.get_mining_leaderboard(10)
        }

    def get_stats(self):
        latest_block = self.get_latest_block()
        self.cleanup_mempool()

        return {
            "name": "ZyronChain",
            "blocks": len(self.chain),
            "current_block_height": len(self.chain) - 1,
            "latest_block_hash": latest_block.hash,
            "difficulty": self.difficulty,
            "cumulative_work": self.get_chain_work(),
            "pending_transactions": len(self.pending_transactions),
            "max_mempool_size": self.MAX_MEMPOOL_SIZE,
            "mempool_ttl_seconds": self.MEMPOOL_TX_TTL_SECONDS,
            "total_transactions": self.get_total_transaction_count(),
            "total_addresses": len(self.get_all_addresses()),
            "average_block_time_seconds": self.get_average_block_time(),
            "chain_valid": self.is_chain_valid(),
            "supply": self.get_supply_info(),
            "network": self.get_network_info()
        }

    def is_chain_valid(self):
        return self.is_valid_chain(self.chain)

from zyron.block import Block
from zyron.transaction import Transaction
from zyron.storage import BlockchainStorage


class Blockchain:
    def __init__(self):
        self.storage = BlockchainStorage()
        self.chain = [self.create_genesis_block()]
        self.difficulty = 4
        self.pending_transactions = []
        self.max_supply = 50_000_000
        self.initial_mining_reward = 50
        self.halving_interval = 100_000
        self.mining_reward = self.get_current_reward()
        self.load_chain()

    def create_genesis_block(self):
        return Block(0, ["Genesis Block"], "0")

    def get_latest_block(self):
        return self.chain[-1]

    def block_to_dict(self, block):
        return {
            "index": block.index,
            "timestamp": block.timestamp,
            "transactions": block.transactions,
            "previous_hash": block.previous_hash,
            "difficulty": block.difficulty,
            "nonce": block.nonce,
            "hash": block.hash
        }

    def dict_to_block(self, block_data):
        block = Block(
            block_data["index"],
            block_data["transactions"],
            block_data["previous_hash"],
            block_data.get("difficulty", 4)
        )
        block.timestamp = block_data["timestamp"]
        block.nonce = block_data["nonce"]
        block.hash = block_data["hash"]
        return block

    def save_chain(self):
        self.storage.save_chain([self.block_to_dict(block) for block in self.chain])

    def load_chain(self):
        data = self.storage.load_chain()
        if not data:
            return
        self.chain = [self.dict_to_block(block_data) for block_data in data]
        self.mining_reward = self.get_current_reward()

    def get_total_supply(self):
        total = 0

        for block in self.chain:
            for tx in block.transactions:
                if isinstance(tx, dict) and tx.get("sender") == "SYSTEM":
                    total += tx.get("amount", 0)

        return total

    def get_current_reward(self):
        halvings = len(self.chain) // self.halving_interval
        reward = self.initial_mining_reward / (2 ** halvings)

        if reward < 0.00000001:
            return 0

        return reward

    def get_remaining_supply(self):
        remaining = self.max_supply - self.get_total_supply()
        return max(remaining, 0)

    def get_supply_info(self):
        return {
            "max_supply": self.max_supply,
            "total_supply": self.get_total_supply(),
            "remaining_supply": self.get_remaining_supply(),
            "current_reward": self.get_current_reward(),
            "halving_interval": self.halving_interval,
            "next_halving_block": (
                ((len(self.chain) // self.halving_interval) + 1)
                * self.halving_interval
            ),
            "current_block_height": len(self.chain) - 1
        }

    def get_block(self, index):
        try:
            index = int(index)
        except ValueError:
            return {
                "found": False,
                "error": "Invalid block index"
            }

        for block in self.chain:
            if block.index == index:
                return {
                    "found": True,
                    "block": self.block_to_dict(block)
                }

        return {
            "found": False,
            "error": "Block not found",
            "index": index
        }

    def is_valid_chain(self, chain_to_validate):
        target = "0" * self.difficulty

        for i in range(1, len(chain_to_validate)):
            current = chain_to_validate[i]
            previous = chain_to_validate[i - 1]

            if current.hash != current.calculate_hash():
                return False

            if current.previous_hash != previous.hash:
                return False

            if not current.hash.startswith(target):
                return False

            for tx_data in current.transactions:
                if isinstance(tx_data, dict):
                    tx = Transaction.from_dict(tx_data)
                    if not tx.is_valid():
                        return False

        return True

    def replace_chain(self, new_chain_data):
        if not new_chain_data:
            return {"replaced": False, "reason": "No chain data provided"}

        new_chain = [self.dict_to_block(block_data) for block_data in new_chain_data]

        if len(new_chain) <= len(self.chain):
            return {"replaced": False, "reason": "Incoming chain is not longer"}

        if not self.is_valid_chain(new_chain):
            return {"replaced": False, "reason": "Incoming chain is invalid"}

        self.chain = new_chain
        self.pending_transactions = []
        self.mining_reward = self.get_current_reward()
        self.save_chain()

        return {"replaced": True, "new_length": len(self.chain)}

    def has_transaction(self, txid):
        for block in self.chain:
            for tx in block.transactions:
                if isinstance(tx, dict) and tx.get("txid") == txid:
                    return True

        for tx in self.pending_transactions:
            if isinstance(tx, dict) and tx.get("txid") == txid:
                return True

        return False

    def add_transaction_from_dict(self, tx_data):
        if not isinstance(tx_data, dict):
            return {
                "accepted": False,
                "reason": "Invalid transaction data"
            }

        txid = tx_data.get("txid")

        if not txid:
            return {
                "accepted": False,
                "reason": "Missing txid"
            }

        if self.has_transaction(txid):
            return {
                "accepted": False,
                "reason": "Transaction already exists",
                "txid": txid
            }

        try:
            tx = Transaction.from_dict(tx_data)
            accepted_txid = self.add_transaction(tx)

            return {
                "accepted": True,
                "txid": accepted_txid
            }

        except Exception as error:
            return {
                "accepted": False,
                "reason": str(error),
                "txid": txid
            }

    def sync_mempool(self, remote_transactions):
        if not isinstance(remote_transactions, list):
            return {
                "accepted": 0,
                "rejected": 0,
                "results": [],
                "reason": "Remote transactions must be a list"
            }

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

        return {
            "accepted": accepted,
            "rejected": rejected,
            "pending_transactions": len(self.pending_transactions),
            "results": results
        }

    def get_pending_spent_amount(self, address):
        total = 0
        for tx in self.pending_transactions:
            if isinstance(tx, dict) and tx.get("sender") == address:
                total += tx["amount"]
        return total

    def get_available_balance(self, address):
        return self.get_balance(address) - self.get_pending_spent_amount(address)

    def add_transaction(self, transaction):
        if not transaction.is_valid():
            raise Exception("Invalid transaction signature")

        if self.has_transaction(transaction.txid):
            raise Exception("Transaction already exists")

        if transaction.sender == "SYSTEM":
            self.pending_transactions.append(transaction.to_dict())
            return transaction.txid

        if transaction.amount <= 0:
            raise Exception("Transaction amount must be greater than zero")

        if self.get_available_balance(transaction.sender) < transaction.amount:
            raise Exception("Insufficient balance")

        self.pending_transactions.append(transaction.to_dict())
        return transaction.txid

    def mine_pending_transactions(self, miner_address):
        current_reward = self.get_current_reward()
        remaining_supply = self.get_remaining_supply()

        if remaining_supply <= 0:
            current_reward = 0

        if current_reward > remaining_supply:
            current_reward = remaining_supply

        if current_reward > 0:
            reward_tx = Transaction("SYSTEM", miner_address, current_reward)
            self.pending_transactions.append(reward_tx.to_dict())

        block = Block(
            len(self.chain),
            self.pending_transactions,
            self.get_latest_block().hash,
            self.difficulty
        )

        block.mine()
        self.chain.append(block)
        self.mining_reward = self.get_current_reward()
        self.save_chain()
        self.pending_transactions = []

    def get_balance(self, address):
        balance = 0

        for block in self.chain:
            for tx in block.transactions:
                if isinstance(tx, dict):
                    if tx["sender"] == address:
                        balance -= tx["amount"]
                    if tx["receiver"] == address:
                        balance += tx["amount"]

        return balance

    def get_transaction(self, txid):
        for block in self.chain:
            for tx in block.transactions:
                if isinstance(tx, dict) and tx.get("txid") == txid:
                    return {
                        "found": True,
                        "block_index": block.index,
                        "transaction": tx
                    }

        for tx in self.pending_transactions:
            if isinstance(tx, dict) and tx.get("txid") == txid:
                return {
                    "found": True,
                    "block_index": None,
                    "status": "pending",
                    "transaction": tx
                }

        return {"found": False, "txid": txid}

    def get_address_transactions(self, address):
        transactions = []

        for block in self.chain:
            for tx in block.transactions:
                if not isinstance(tx, dict):
                    continue

                if tx.get("sender") == address or tx.get("receiver") == address:
                    transactions.append({
                        "block_index": block.index,
                        "txid": tx.get("txid"),
                        "sender": tx.get("sender"),
                        "receiver": tx.get("receiver"),
                        "amount": tx.get("amount"),
                        "timestamp": tx.get("timestamp")
                    })

        transactions.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
        return transactions

    def is_chain_valid(self):
        return self.is_valid_chain(self.chain)

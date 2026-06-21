from zyron.block import Block
from zyron.transaction import Transaction
from zyron.storage import BlockchainStorage


class Blockchain:
    def __init__(self):
        self.storage = BlockchainStorage()

        self.chain = [self.create_genesis_block()]
        self.difficulty = 4
        self.pending_transactions = []
        self.mining_reward = 50

        self.load_chain()

    def create_genesis_block(self):
        return Block(
            0,
            ["Genesis Block"],
            "0"
        )

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
        chain_data = []

        for block in self.chain:
            chain_data.append(
                self.block_to_dict(block)
            )

        self.storage.save_chain(chain_data)

    def load_chain(self):
        data = self.storage.load_chain()

        if not data:
            return

        loaded_chain = []

        for block_data in data:
            loaded_chain.append(
                self.dict_to_block(block_data)
            )

        if loaded_chain:
            self.chain = loaded_chain

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
            return {
                "replaced": False,
                "reason": "No chain data provided"
            }

        new_chain = []

        for block_data in new_chain_data:
            new_chain.append(
                self.dict_to_block(block_data)
            )

        if len(new_chain) <= len(self.chain):
            return {
                "replaced": False,
                "reason": "Incoming chain is not longer"
            }

        if not self.is_valid_chain(new_chain):
            return {
                "replaced": False,
                "reason": "Incoming chain is invalid"
            }

        self.chain = new_chain
        self.pending_transactions = []
        self.save_chain()

        return {
            "replaced": True,
            "new_length": len(self.chain)
        }

    def get_pending_spent_amount(self, address):
        total = 0

        for tx in self.pending_transactions:
            if isinstance(tx, dict) and tx.get("sender") == address:
                total += tx["amount"]

        return total

    def get_available_balance(self, address):
        confirmed_balance = self.get_balance(address)
        pending_spent = self.get_pending_spent_amount(address)

        return confirmed_balance - pending_spent

    def add_transaction(self, transaction):
        if not transaction.is_valid():
            raise Exception("Invalid transaction signature")

        if transaction.sender == "SYSTEM":
            self.pending_transactions.append(
                transaction.to_dict()
            )
            return transaction.txid

        if transaction.amount <= 0:
            raise Exception("Transaction amount must be greater than zero")

        available_balance = self.get_available_balance(transaction.sender)

        if available_balance < transaction.amount:
            raise Exception("Insufficient balance")

        self.pending_transactions.append(
            transaction.to_dict()
        )

        return transaction.txid

    def mine_pending_transactions(self, miner_address):
        reward_tx = Transaction(
            "SYSTEM",
            miner_address,
            self.mining_reward
        )

        self.pending_transactions.append(
            reward_tx.to_dict()
        )

        block = Block(
            len(self.chain),
            self.pending_transactions,
            self.get_latest_block().hash,
            self.difficulty
        )

        block.mine()
        self.chain.append(block)
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

        return {
            "found": False,
            "txid": txid
        }

    def is_chain_valid(self):
        return self.is_valid_chain(self.chain)

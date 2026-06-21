from zyron.block import Block
from zyron.transaction import Transaction


class Blockchain:
    def __init__(self):
        self.chain = [self.create_genesis_block()]
        self.difficulty = 4
        self.pending_transactions = []
        self.mining_reward = 50

    def create_genesis_block(self):
        return Block(
            0,
            ["Genesis Block"],
            "0"
        )

    def get_latest_block(self):
        return self.chain[-1]

    def add_transaction(self, transaction):
        if not transaction.is_valid():
            raise Exception("Invalid transaction signature")

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
        target = "0" * self.difficulty

        for i in range(1, len(self.chain)):
            current = self.chain[i]
            previous = self.chain[i - 1]

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

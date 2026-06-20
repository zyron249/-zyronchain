from zyron.block import Block
from zyron.transaction import Transaction


class Blockchain:
    def __init__(self):
        self.chain = [self.create_genesis_block()]
        self.difficulty = 4
        self.pending_transactions = []
        self.mining_reward = 50

    def create_genesis_block(self):
        return Block(0, ["Genesis Block"], "0")

    def get_latest_block(self):
        return self.chain[-1]

    def add_transaction(self, sender, receiver, amount):
        tx = Transaction(sender, receiver, amount)
        self.pending_transactions.append(tx.to_dict())
        return tx.txid

    def mine_pending_transactions(self, miner_address):
        reward_tx = Transaction("SYSTEM", miner_address, self.mining_reward)
        self.pending_transactions.append(reward_tx.to_dict())

        new_block = Block(
            len(self.chain),
            self.pending_transactions,
            self.get_latest_block().hash,
            self.difficulty
        )

        new_block.mine()
        self.chain.append(new_block)
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

    def is_chain_valid(self):
        for i in range(1, len(self.chain)):
            current = self.chain[i]
            previous = self.chain[i - 1]

            if current.hash != current.calculate_hash():
                return False

            if current.previous_hash != previous.hash:
                return False

        return True

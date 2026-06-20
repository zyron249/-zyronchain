import hashlib
import time
import json


class Block:
    def __init__(self, index, transactions, previous_hash, difficulty=4):
        self.index = index
        self.timestamp = time.time()
        self.transactions = transactions
        self.previous_hash = previous_hash
        self.difficulty = difficulty
        self.nonce = 0
        self.hash = self.calculate_hash()

    def calculate_hash(self):
        data = {
            "index": self.index,
            "timestamp": self.timestamp,
            "transactions": self.transactions,
            "previous_hash": self.previous_hash,
            "difficulty": self.difficulty,
            "nonce": self.nonce
        }

        block_string = json.dumps(data, sort_keys=True)
        return hashlib.sha256(block_string.encode()).hexdigest()

    def mine(self):
        target = "0" * self.difficulty

        while not self.hash.startswith(target):
            self.nonce += 1
            self.hash = self.calculate_hash()

        print("Block mined:", self.hash)

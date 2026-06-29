import hashlib
import time
import json


class Block:
    def __init__(
        self,
        index,
        transactions,
        previous_hash,
        difficulty=4,
        timestamp=None
    ):
        self.index = index
        self.timestamp = time.time() if timestamp is None else float(timestamp)
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

        block_string = json.dumps(
            data,
            sort_keys=True,
            separators=(",", ":")
        )

        return hashlib.sha256(
            block_string.encode("utf-8")
        ).hexdigest()

    def mine(self):
        target = "0" * self.difficulty

        while True:
            self.hash = self.calculate_hash()

            if self.hash.startswith(target):
                break

            self.nonce += 1

        print(f"Block mined: {self.hash}")

import hashlib
import json
import math
import time


class Block:
    LEGACY_VERSION = 1
    CURRENT_VERSION = 2

    def __init__(
        self,
        index,
        transactions,
        previous_hash,
        difficulty=4,
        timestamp=None,
        *,
        version=CURRENT_VERSION,
        timestamp_ms=None,
        merkle_root=None
    ):
        if isinstance(version, bool) or not isinstance(version, int):
            raise ValueError("Block version must be an integer")
        self.version = version
        self.index = index
        self.transactions = transactions
        self.previous_hash = previous_hash
        self.difficulty = difficulty
        self.nonce = 0

        if version == self.LEGACY_VERSION:
            self.timestamp = time.time() if timestamp is None else float(timestamp)
            self.timestamp_ms = None
            self.merkle_root = None
        elif version == self.CURRENT_VERSION:
            if timestamp_ms is None:
                if timestamp is None:
                    timestamp_ms = time.time_ns() // 1_000_000
                else:
                    numeric_timestamp = float(timestamp)
                    if not math.isfinite(numeric_timestamp):
                        raise ValueError("Block timestamp must be finite")
                    timestamp_ms = int(numeric_timestamp * 1000)
            if isinstance(timestamp_ms, bool) or not isinstance(timestamp_ms, int):
                raise ValueError("timestamp_ms must be an integer")
            self.timestamp_ms = timestamp_ms
            self.timestamp = timestamp_ms / 1000
            calculated_merkle = self.calculate_merkle_root()
            if merkle_root is not None and merkle_root != calculated_merkle:
                raise ValueError("Merkle root does not match transactions")
            self.merkle_root = calculated_merkle
        else:
            raise ValueError("Unsupported block version")

        self.hash = self.calculate_hash()

    @staticmethod
    def _canonical_transaction(transaction):
        return json.dumps(
            transaction,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False
        ).encode("utf-8")

    def calculate_merkle_root(self):
        if not self.transactions:
            return hashlib.sha256(b"").hexdigest()

        level = [
            hashlib.sha256(self._canonical_transaction(tx)).digest()
            for tx in self.transactions
        ]
        while len(level) > 1:
            if len(level) % 2:
                level.append(level[-1])
            level = [
                hashlib.sha256(level[i] + level[i + 1]).digest()
                for i in range(0, len(level), 2)
            ]
        return level[0].hex()

    def calculate_hash(self):
        if self.version == self.LEGACY_VERSION:
            data = {
                "index": self.index,
                "timestamp": self.timestamp,
                "transactions": self.transactions,
                "previous_hash": self.previous_hash,
                "difficulty": self.difficulty,
                "nonce": self.nonce
            }
        else:
            data = {
                "version": self.version,
                "index": self.index,
                "timestamp_ms": self.timestamp_ms,
                "merkle_root": self.merkle_root,
                "previous_hash": self.previous_hash,
                "difficulty": self.difficulty,
                "nonce": self.nonce
            }

        block_string = json.dumps(data, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(block_string.encode("utf-8")).hexdigest()

    def mine(self):
        target = "0" * self.difficulty
        while True:
            self.hash = self.calculate_hash()
            if self.hash.startswith(target):
                break
            self.nonce += 1
        print(f"Block mined: {self.hash}")

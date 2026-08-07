import time
import hashlib
import math
import ecdsa


class Transaction:
    LEGACY_VERSION = 1
    CURRENT_VERSION = 2

    def __init__(
        self,
        sender,
        receiver,
        amount,
        public_key=None,
        signature=None,
        timestamp=None,
        txid=None,
        version=2,
        chain_id="zyron-testnet-1",
        nonce=0,
        fee=0.01
    ):
        self.version = version
        self.chain_id = chain_id
        self.nonce = nonce
        self.sender = sender
        self.receiver = receiver
        self.amount = float(amount)
        self.fee = float(fee)
        self.timestamp = timestamp if timestamp is not None else time.time()
        self.public_key = public_key
        self.signature = signature
        self.txid = txid if txid is not None else self.calculate_txid()

    def calculate_txid(self):
        data = (
            f"{self.version}"
            f"{self.chain_id}"
            f"{self.nonce}"
            f"{self.sender}"
            f"{self.receiver}"
            f"{self.amount}"
            f"{self.fee}"
            f"{self.timestamp}"
            f"{self.public_key}"
        )
        return hashlib.sha256(data.encode()).hexdigest()

    def data_to_sign(self):
        return (
            f"{self.version}"
            f"{self.chain_id}"
            f"{self.nonce}"
            f"{self.sender}"
            f"{self.receiver}"
            f"{self.amount}"
            f"{self.fee}"
            f"{self.timestamp}"
        )

    def sign_transaction(self, private_key_hex):
        if self.version not in (self.LEGACY_VERSION, self.CURRENT_VERSION):
            raise ValueError("Unsupported transaction version")

        private_key = ecdsa.SigningKey.from_string(
            bytes.fromhex(private_key_hex),
            curve=ecdsa.SECP256k1
        )

        hashfunc = (
            hashlib.sha1
            if self.version == self.LEGACY_VERSION
            else hashlib.sha256
        )

        self.signature = private_key.sign_deterministic(
            self.data_to_sign().encode(),
            hashfunc=hashfunc
        ).hex()

    def is_valid(self):
        if self.chain_id != "zyron-testnet-1":
            return False

        if self.version not in (self.LEGACY_VERSION, self.CURRENT_VERSION):
            return False

        if not math.isfinite(self.amount) or not math.isfinite(self.fee):
            return False

        try:
            timestamp = float(self.timestamp)
        except (TypeError, ValueError, OverflowError):
            return False

        if not math.isfinite(timestamp):
            return False

        if not isinstance(self.txid, str) or len(self.txid) != 64:
            return False

        try:
            bytes.fromhex(self.txid)
        except ValueError:
            return False

        if self.sender == "SYSTEM":
            if self.amount <= 0:
                return False

            if self.fee != 0 or self.nonce != 0:
                return False

            if self.public_key is not None or self.signature is not None:
                return False

            return self.txid == self.calculate_txid()

        if self.amount <= 0:
            return False

        if self.fee < 0:
            return False

        if self.nonce < 0:
            return False

        if self.txid != self.calculate_txid():
            return False

        if not self.public_key or not self.signature:
            return False

        if not isinstance(self.public_key, str) or len(self.public_key) != 128:
            return False

        if not isinstance(self.signature, str) or len(self.signature) != 128:
            return False

        try:
            public_key = ecdsa.VerifyingKey.from_string(
                bytes.fromhex(self.public_key),
                curve=ecdsa.SECP256k1
            )

            hashfunc = (
                hashlib.sha1
                if self.version == self.LEGACY_VERSION
                else hashlib.sha256
            )

            return public_key.verify(
                bytes.fromhex(self.signature),
                self.data_to_sign().encode(),
                hashfunc=hashfunc
            )

        except Exception:
            return False

    @staticmethod
    def from_dict(data):
        return Transaction(
            version=data.get("version", 1),
            chain_id=data.get("chain_id", "zyron-testnet-1"),
            nonce=int(data.get("nonce", 0)),
            sender=data["sender"],
            receiver=data["receiver"],
            amount=float(data["amount"]),
            fee=float(data.get("fee", 0.01)),
            public_key=data.get("public_key"),
            signature=data.get("signature"),
            timestamp=data.get("timestamp"),
            txid=data.get("txid")
        )

    def to_dict(self):
        return {
            "version": self.version,
            "chain_id": self.chain_id,
            "nonce": self.nonce,
            "sender": self.sender,
            "receiver": self.receiver,
            "amount": self.amount,
            "fee": self.fee,
            "timestamp": self.timestamp,
            "public_key": self.public_key,
            "signature": self.signature,
            "txid": self.txid
        }

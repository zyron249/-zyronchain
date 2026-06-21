import time
import hashlib
import ecdsa


class Transaction:
    def __init__(self, sender, receiver, amount, public_key=None, signature=None, timestamp=None, txid=None):
        self.sender = sender
        self.receiver = receiver
        self.amount = amount
        self.timestamp = timestamp if timestamp is not None else time.time()
        self.public_key = public_key
        self.signature = signature
        self.txid = txid if txid is not None else self.calculate_txid()

    def calculate_txid(self):
        data = f"{self.sender}{self.receiver}{self.amount}{self.timestamp}{self.public_key}"
        return hashlib.sha256(data.encode()).hexdigest()

    def data_to_sign(self):
        return f"{self.sender}{self.receiver}{self.amount}{self.timestamp}"

    def sign_transaction(self, private_key_hex):
        private_key = ecdsa.SigningKey.from_string(
            bytes.fromhex(private_key_hex),
            curve=ecdsa.SECP256k1
        )

        self.signature = private_key.sign(
            self.data_to_sign().encode()
        ).hex()

    def is_valid(self):
        if self.sender == "SYSTEM":
            return True

        if self.txid != self.calculate_txid():
            return False

        if not self.public_key or not self.signature:
            return False

        try:
            public_key = ecdsa.VerifyingKey.from_string(
                bytes.fromhex(self.public_key),
                curve=ecdsa.SECP256k1
            )

            return public_key.verify(
                bytes.fromhex(self.signature),
                self.data_to_sign().encode()
            )

        except Exception:
            return False

    @staticmethod
    def from_dict(data):
        return Transaction(
            sender=data["sender"],
            receiver=data["receiver"],
            amount=data["amount"],
            public_key=data.get("public_key"),
            signature=data.get("signature"),
            timestamp=data.get("timestamp"),
            txid=data.get("txid")
        )

    def to_dict(self):
        return {
            "sender": self.sender,
            "receiver": self.receiver,
            "amount": self.amount,
            "timestamp": self.timestamp,
            "public_key": self.public_key,
            "signature": self.signature,
            "txid": self.txid
        }

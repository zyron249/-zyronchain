import hashlib
import ecdsa


class Wallet:
    def __init__(self):
        self.private_key = ecdsa.SigningKey.generate(curve=ecdsa.SECP256k1)
        self.public_key = self.private_key.get_verifying_key()
        self.address = self.create_address()

    def create_address(self):
        public_key_bytes = self.public_key.to_string()
        sha256_hash = hashlib.sha256(public_key_bytes).hexdigest()
        return "ZYN" + sha256_hash[:40]

    def get_private_key(self):
        return self.private_key.to_string().hex()

    def get_public_key(self):
        return self.public_key.to_string().hex()

    def to_dict(self):
        return {
            "address": self.address,
            "private_key": self.get_private_key(),
            "public_key": self.get_public_key()
        }

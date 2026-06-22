import hashlib
import ecdsa
import secrets


WORD_LIST = [
    "apple", "river", "moon", "stone", "cloud", "fire",
    "tree", "wolf", "mountain", "light", "ocean", "star",
    "gold", "shadow", "wind", "earth", "blue", "green",
    "storm", "sun", "night", "dream", "iron", "silver"
]


class Wallet:
    def __init__(self, mnemonic=None):
        self.mnemonic = mnemonic if mnemonic else self.generate_mnemonic()
        self.private_key = self.private_key_from_mnemonic(self.mnemonic)
        self.public_key = self.private_key.get_verifying_key()
        self.address = self.create_address()

    def generate_mnemonic(self):
        words = []

        for _ in range(12):
            words.append(secrets.choice(WORD_LIST))

        return " ".join(words)

    def private_key_from_mnemonic(self, mnemonic):
        seed = hashlib.sha256(mnemonic.encode()).digest()

        return ecdsa.SigningKey.from_string(
            seed,
            curve=ecdsa.SECP256k1
        )

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
            "mnemonic": self.mnemonic,
            "private_key": self.get_private_key(),
            "public_key": self.get_public_key()
        }

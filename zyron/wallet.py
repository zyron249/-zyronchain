import hashlib
from coincurve import PrivateKey
from mnemonic import Mnemonic


def address_from_public_key(public_key_hex):
    public_key_bytes = bytes.fromhex(public_key_hex)
    sha256_hash = hashlib.sha256(public_key_bytes).hexdigest()
    return "ZYN" + sha256_hash[:40]


class Wallet:
    def __init__(self, mnemonic=None):
        self.mnemo = Mnemonic("english")

        if mnemonic:
            if not self.mnemo.check(mnemonic):
                raise ValueError("Invalid BIP39 mnemonic")
            self.mnemonic = mnemonic
        else:
            self.mnemonic = self.generate_mnemonic()

        self.private_key = self.private_key_from_mnemonic(self.mnemonic)
        self.public_key = self.private_key.public_key
        self.address = self.create_address()

    def generate_mnemonic(self):
        return self.mnemo.generate(strength=128)

    def private_key_from_mnemonic(self, mnemonic):
        seed = self.mnemo.to_seed(mnemonic, passphrase="")
        private_key_bytes = hashlib.sha256(seed).digest()

        return PrivateKey(private_key_bytes)

    def create_address(self):
        return address_from_public_key(self.get_public_key())

    def get_private_key(self):
        return self.private_key.secret.hex()

    def get_public_key(self):
        return self.public_key.format(compressed=False)[1:].hex()

    def to_dict(self):
        return {
            "address": self.address,
            "mnemonic": self.mnemonic,
            "private_key": self.get_private_key(),
            "public_key": self.get_public_key()
        }

import json
import os
class BlockchainStorage:
    def __init__(self, filename="blockchain.json"):
        self.filename = filename
    def save_chain(self, chain_data):
        with open(self.filename, "w") as f:
            json.dump(chain_data, f, indent=4)
    def load_chain(self):
        if not os.path.exists(self.filename):
            return None
        with open(self.filename, "r") as f:
            return json.load(f)

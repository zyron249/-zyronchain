from zyron.block import Block


class Blockchain:
    def __init__(self):
        self.chain = [self.create_genesis_block()]
        self.difficulty = 4

    def create_genesis_block(self):
        genesis = Block(
            0,
            ["Genesis Block"],
            "0"
        )
        return genesis

    def get_latest_block(self):
        return self.chain[-1]

    def add_block(self, transactions):
        previous_block = self.get_latest_block()

        new_block = Block(
            len(self.chain),
            transactions,
            previous_block.hash,
            self.difficulty
        )

        new_block.mine()
        self.chain.append(new_block)

    def is_chain_valid(self):
        for i in range(1, len(self.chain)):
            current = self.chain[i]
            previous = self.chain[i - 1]

            if current.hash != current.calculate_hash():
                return False

            if current.previous_hash != previous.hash:
                return False

        return True

def is_chain_valid(self):

    target = "0" * self.difficulty

    for i in range(1, len(self.chain)):

        current = self.chain[i]
        previous = self.chain[i - 1]

        if current.hash != current.calculate_hash():
            return False

        if current.previous_hash != previous.hash:
            return False

        if not current.hash.startswith(target):
            return False

        for tx_data in current.transactions:

            if isinstance(tx_data, dict):
                tx = Transaction.from_dict(tx_data)

                if not tx.is_valid():
                    return False

    return True

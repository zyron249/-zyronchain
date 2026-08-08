"""Small local ZyronChain protocol demo.

Run the network node with ``gunicorn --workers 1 app:app``. This module is
intentionally offline and never prints private keys or mnemonic phrases.
"""

from zyron.blockchain import Blockchain
from zyron.transaction import Transaction
from zyron.wallet import Wallet


def main():
    chain = Blockchain()
    alice = Wallet()
    bob = Wallet()
    miner = Wallet()

    print("Alice:", alice.address)
    print("Bob:", bob.address)
    print("Miner:", miner.address)

    chain.mine_pending_transactions(alice.address)

    transaction = Transaction(
        sender=alice.address,
        receiver=bob.address,
        amount="10",
        fee="0.01",
        public_key=alice.get_public_key(),
        nonce=chain.get_next_nonce(alice.address)
    )
    transaction.sign_transaction(alice.get_private_key())
    chain.add_transaction(transaction)
    chain.mine_pending_transactions(miner.address)

    print("\nBalances")
    print("Alice:", chain.get_balance(alice.address))
    print("Bob:", chain.get_balance(bob.address))
    print("Miner:", chain.get_balance(miner.address))
    print("\nChain valid:", chain.is_chain_valid())
    print("Total blocks:", len(chain.chain))


if __name__ == "__main__":
    main()

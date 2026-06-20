from zyron.blockchain import Blockchain
from zyron.wallet import Wallet
from zyron.transaction import Transaction

chain = Blockchain()

alice = Wallet()
bob = Wallet()
miner = Wallet()

tx = Transaction(
    alice.address,
    bob.address,
    10,
    alice.get_public_key()
)

tx.sign_transaction(alice.get_private_key())

chain.add_transaction(tx)
chain.mine_pending_transactions(miner.address)

print("Alice:", alice.address)
print("Bob:", bob.address)
print("Miner:", miner.address)

print("Alice Balance:", chain.get_balance(alice.address))
print("Bob Balance:", chain.get_balance(bob.address))
print("Miner Balance:", chain.get_balance(miner.address))

print("Chain Valid:", chain.is_chain_valid())

from zyron.blockchain import Blockchain
from zyron.wallet import create_wallet_address

chain = Blockchain()

alice = create_wallet_address("Alice")
bob = create_wallet_address("Bob")
miner = create_wallet_address("Miner")

print("Alice:", alice)
print("Bob:", bob)
print("Miner:", miner)

chain.add_transaction(alice, bob, 10)
chain.add_transaction(bob, alice, 3)

print("\nMining block...")
chain.mine_pending_transactions(miner)

print("\nBalances")
print("Alice:", chain.get_balance(alice))
print("Bob:", chain.get_balance(bob))
print("Miner:", chain.get_balance(miner))

print("\nChain Valid:", chain.is_chain_valid())
print("Total Blocks:", len(chain.chain))

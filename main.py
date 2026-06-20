from zyron.blockchain import Blockchain

chain = Blockchain()

print("Creating Block 1...")
chain.add_block([
    "Alice -> Bob : 10 ZYN"
])

print("Creating Block 2...")
chain.add_block([
    "Bob -> Charlie : 5 ZYN"
])

print("\nBlockchain Status")
print("-----------------")
print("Total Blocks:", len(chain.chain))
print("Chain Valid:", chain.is_chain_valid())

for block in chain.chain:
    print("\nBlock:", block.index)
    print("Hash:", block.hash)
    print("Previous:", block.previous_hash)
    print("Transactions:", block.transactions)

from zyron.blockchain import Blockchain
from zyron.transaction import Transaction
from zyron.wallet import Wallet


chain = Blockchain()
alice = Wallet()
bob = Wallet()
miner = Wallet()

# Give Alice a protocol-valid mining reward before she spends funds.
chain.mine_pending_transactions(alice.address)

tx = Transaction(
    sender=alice.address,
    receiver=bob.address,
    amount="10",
    fee="0.01",
    public_key=alice.get_public_key(),
    nonce=chain.get_next_nonce(alice.address)
)
tx.sign_transaction(alice.get_private_key())
chain.add_transaction(tx)
chain.mine_pending_transactions(miner.address)

print("Alice:", alice.address, chain.get_balance(alice.address))
print("Bob:", bob.address, chain.get_balance(bob.address))
print("Miner:", miner.address, chain.get_balance(miner.address))
print("Chain Valid:", chain.is_chain_valid())

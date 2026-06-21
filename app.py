import os
from flask import Flask, request, render_template
from zyron.blockchain import Blockchain
from zyron.wallet import Wallet
from zyron.transaction import Transaction

app = Flask(__name__)
chain = Blockchain()


@app.route("/")
def explorer():
    return render_template(
        "index.html",
        total_blocks=len(chain.chain),
        valid=chain.is_chain_valid(),
        blocks=chain.chain,
        pending_transactions=len(chain.pending_transactions),
        difficulty=chain.difficulty,
        mining_reward=chain.mining_reward
    )


@app.route("/api")
def api_home():
    return {
        "name": "ZyronChain",
        "blocks": len(chain.chain),
        "pending_transactions": len(chain.pending_transactions),
        "difficulty": chain.difficulty,
        "mining_reward": chain.mining_reward,
        "valid": chain.is_chain_valid()
    }


@app.route("/wallet/new")
def new_wallet():
    wallet = Wallet()
    return wallet.to_dict()


@app.route("/mine/<address>")
def mine(address):
    chain.mine_pending_transactions(address)
    return {
        "message": "Block mined",
        "miner": address,
        "total_blocks": len(chain.chain)
    }


@app.route("/balance/<address>")
def balance(address):
    return {
        "address": address,
        "balance": chain.get_balance(address)
    }


@app.route("/transaction", methods=["POST"])
def transaction():
    data = request.json

    tx = Transaction(
        sender=data["sender"],
        receiver=data["receiver"],
        amount=data["amount"],
        public_key=data.get("public_key"),
        signature=data.get("signature"),
        timestamp=data.get("timestamp"),
        txid=data.get("txid")
    )

    txid = chain.add_transaction(tx)

    return {
        "message": "Transaction added to mempool",
        "txid": txid,
        "pending_transactions": len(chain.pending_transactions)
    }


@app.route("/mempool")
def mempool():
    return {
        "pending_transactions": chain.pending_transactions,
        "count": len(chain.pending_transactions)
    }


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)

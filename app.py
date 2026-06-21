from flask import Flask, request, render_template
from zyron.blockchain import Blockchain
from zyron.wallet import Wallet

app = Flask(__name__)

chain = Blockchain()


@app.route("/")
def explorer():
    return render_template(
        "index.html",
        total_blocks=len(chain.chain),
        valid=chain.is_chain_valid(),
        blocks=chain.chain
    )


@app.route("/api")
def api_home():
    return {
        "name": "ZyronChain",
        "blocks": len(chain.chain),
        "valid": chain.is_chain_valid()
    }


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
@app.route("/wallet/new")
def new_wallet():
    wallet = Wallet()

    return {
        "address": wallet.address,
        "public_key": wallet.get_public_key(),
        "private_key": wallet.get_private_key()
    }

@app.route("/transaction", methods=["POST"])
def transaction():
    data = request.json

    txid = chain.add_transaction(
        data["sender"],
        data["receiver"],
        data["amount"]
    )

    return {
        "txid": txid,
        "message": "Transaction added"
    }


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)

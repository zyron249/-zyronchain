import os
import requests
from flask import Flask, request, render_template
from zyron.blockchain import Blockchain
from zyron.wallet import Wallet
from zyron.transaction import Transaction

app = Flask(__name__)
chain = Blockchain()
peers = set()


def block_to_dict(block):
    return {
        "index": block.index,
        "timestamp": block.timestamp,
        "transactions": block.transactions,
        "previous_hash": block.previous_hash,
        "difficulty": block.difficulty,
        "nonce": block.nonce,
        "hash": block.hash
    }


@app.route("/")
def explorer():
    return render_template(
        "index.html",
        total_blocks=len(chain.chain),
        valid=chain.is_chain_valid(),
        blocks=chain.chain,
        pending_transactions=len(chain.pending_transactions),
        difficulty=chain.difficulty,
        mining_reward=chain.mining_reward,
        peers=len(peers)
    )


@app.route("/api")
def api_home():
    return {
        "name": "ZyronChain",
        "blocks": len(chain.chain),
        "pending_transactions": len(chain.pending_transactions),
        "difficulty": chain.difficulty,
        "mining_reward": chain.mining_reward,
        "peers": list(peers),
        "valid": chain.is_chain_valid()
    }


@app.route("/chain")
def get_chain():
    return {
        "length": len(chain.chain),
        "chain": [block_to_dict(block) for block in chain.chain],
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


@app.route("/nodes")
def get_nodes():
    return {
        "nodes": list(peers),
        "count": len(peers)
    }


@app.route("/nodes/register", methods=["POST"])
def register_node():
    data = request.json
    node = data.get("node")

    if not node:
        return {
            "error": "Node address is required"
        }, 400

    peers.add(node)

    return {
        "message": "Node registered",
        "nodes": list(peers),
        "count": len(peers)
    }


@app.route("/nodes/sync")
def sync_nodes():
    longest_chain = None
    max_length = len(chain.chain)

    for node in peers:
        try:
            response = requests.get(f"{node}/chain", timeout=5)

            if response.status_code == 200:
                data = response.json()
                length = data.get("length")
                remote_chain = data.get("chain")

                if length and remote_chain and length > max_length:
                    max_length = length
                    longest_chain = remote_chain

        except Exception:
            continue

    if longest_chain:
        return {
            "message": "Longer chain found",
            "replaced": False,
            "note": "Chain download works. Full replacement will be added in the next version.",
            "new_length": max_length
        }

    return {
        "message": "Current chain is already the longest",
        "replaced": False,
        "length": len(chain.chain)
    }


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)

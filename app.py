import os
import requests
from flask import Flask, request, render_template
from zyron.blockchain import Blockchain
from zyron.wallet import Wallet
from zyron.transaction import Transaction
from zyron.storage import BlockchainStorage

app = Flask(__name__)
chain = Blockchain()
storage = BlockchainStorage()

peers = set(storage.load_peers())

if not peers:
    peers = {
        "https://zyronchain-node2.onrender.com"
    }
    storage.save_peer("https://zyronchain-node2.onrender.com")


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


@app.route("/debug/db")
def debug_db():
    return {
        "database_url_exists": bool(chain.storage.database_url),
        "database_url_prefix": chain.storage.database_url[:30] if chain.storage.database_url else None,
        "stored_peers": list(peers)
    }


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


@app.route("/address/<address>")
def address_page(address):
    return {
        "address": address,
        "balance": chain.get_balance(address),
        "available_balance": chain.get_available_balance(address),
        "chain_valid": chain.is_chain_valid()
    }


@app.route("/tx/<txid>")
def transaction_page(txid):
    return chain.get_transaction(txid)


@app.route("/transaction", methods=["POST"])
def transaction():
    data = request.json

    tx = Transaction(
        sender=data["sender"],
        receiver=data["receiver"],
        amount=float(data["amount"]),
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


@app.route("/wallet/send", methods=["POST"])
def wallet_send():
    data = request.json or {}

    required_fields = ["sender", "receiver", "amount", "private_key", "public_key"]

    for field in required_fields:
        if field not in data:
            return {
                "message": "Transfer rejected",
                "error": f"Missing field: {field}"
            }, 400

    tx = Transaction(
        sender=data["sender"],
        receiver=data["receiver"],
        amount=float(data["amount"]),
        public_key=data["public_key"]
    )

    try:
        tx.sign_transaction(data["private_key"])
        txid = chain.add_transaction(tx)

        return {
            "message": "Transfer accepted",
            "txid": txid,
            "sender": tx.sender,
            "receiver": tx.receiver,
            "amount": tx.amount,
            "pending_transactions": len(chain.pending_transactions)
        }

    except Exception as error:
        return {
            "message": "Transfer rejected",
            "error": str(error)
        }, 400


@app.route("/transfer/demo", methods=["POST"])
def transfer_demo():
    data = request.json or {}

    sender_wallet = Wallet()
    receiver_wallet = Wallet()

    tx = Transaction(
        sender=sender_wallet.address,
        receiver=receiver_wallet.address,
        amount=float(data.get("amount", 10)),
        public_key=sender_wallet.get_public_key()
    )

    tx.sign_transaction(sender_wallet.get_private_key())

    try:
        txid = chain.add_transaction(tx)

        return {
            "message": "Transfer accepted",
            "txid": txid,
            "sender": sender_wallet.to_dict(),
            "receiver": receiver_wallet.to_dict(),
            "amount": tx.amount,
            "pending_transactions": len(chain.pending_transactions)
        }

    except Exception as error:
        return {
            "message": "Transfer rejected",
            "error": str(error)
        }, 400


@app.route("/test-transfer")
def test_transfer():
    sender_wallet = Wallet()
    receiver_wallet = Wallet()

    tx = Transaction(
        sender=sender_wallet.address,
        receiver=receiver_wallet.address,
        amount=10,
        public_key=sender_wallet.get_public_key()
    )

    tx.sign_transaction(sender_wallet.get_private_key())

    try:
        txid = chain.add_transaction(tx)

        return {
            "message": "Transfer accepted",
            "txid": txid,
            "sender": sender_wallet.address,
            "receiver": receiver_wallet.address,
            "amount": tx.amount,
            "pending_transactions": len(chain.pending_transactions)
        }

    except Exception as error:
        return {
            "message": "Transfer rejected",
            "error": str(error)
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
    storage.save_peer(node)

    return {
        "message": "Node registered",
        "nodes": list(peers),
        "count": len(peers)
    }


@app.route("/nodes/sync")
def sync_nodes():
    sync_results = []
    replaced = False

    for node in peers:
        try:
            response = requests.get(f"{node}/chain", timeout=5)

            if response.status_code != 200:
                sync_results.append({
                    "node": node,
                    "status": "failed",
                    "reason": f"HTTP {response.status_code}"
                })
                continue

            data = response.json()
            remote_chain = data.get("chain")
            remote_length = data.get("length")

            result = chain.replace_chain(remote_chain)

            sync_results.append({
                "node": node,
                "remote_length": remote_length,
                "result": result
            })

            if result.get("replaced"):
                replaced = True

        except Exception as error:
            sync_results.append({
                "node": node,
                "status": "failed",
                "reason": str(error)
            })

    return {
        "message": "Node synchronization completed",
        "replaced": replaced,
        "current_length": len(chain.chain),
        "peers_checked": len(peers),
        "results": sync_results
    }


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)

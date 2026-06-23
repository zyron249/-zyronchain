import os
import requests
import threading
import time
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

AUTO_SYNC_INTERVAL = 60
FAUCET_AMOUNT = 25
FAUCET_COOLDOWN_SECONDS = 24 * 60 * 60


def sync_chain_from_node(node):
    response = requests.get(f"{node}/chain", timeout=5)

    if response.status_code != 200:
        return {
            "node": node,
            "status": "failed",
            "reason": f"HTTP {response.status_code}"
        }

    data = response.json()
    remote_chain = data.get("chain")
    remote_length = data.get("length")

    result = chain.replace_chain(remote_chain)

    return {
        "node": node,
        "remote_length": remote_length,
        "result": result
    }


def sync_mempool_from_node(node):
    response = requests.get(f"{node}/mempool", timeout=5)

    if response.status_code != 200:
        return {
            "node": node,
            "status": "failed",
            "reason": f"HTTP {response.status_code}"
        }

    data = response.json()
    remote_transactions = data.get("pending_transactions", [])

    result = chain.sync_mempool(remote_transactions)

    return {
        "node": node,
        "remote_pending": len(remote_transactions),
        "result": result
    }


def broadcast_transaction(tx_data):
    results = []

    for node in list(peers):
        try:
            response = requests.post(
                f"{node}/transaction",
                json=tx_data,
                timeout=5
            )

            try:
                response_data = response.json()
            except Exception:
                response_data = {"raw_response": response.text}

            results.append({
                "node": node,
                "status_code": response.status_code,
                "response": response_data
            })

        except Exception as error:
            results.append({
                "node": node,
                "status": "failed",
                "reason": str(error)
            })

    return results


def auto_sync_loop():
    while True:
        time.sleep(AUTO_SYNC_INTERVAL)

        for node in list(peers):
            try:
                chain_result = sync_chain_from_node(node)
                mempool_result = sync_mempool_from_node(node)

                print("Auto chain sync:", chain_result)
                print("Auto mempool sync:", mempool_result)

            except Exception as error:
                print("Auto sync failed:", str(error))


sync_thread = threading.Thread(
    target=auto_sync_loop,
    daemon=True
)

sync_thread.start()


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
        mining_reward=chain.get_current_reward(),
        peers=len(peers)
    )


@app.route("/wallet")
def wallet_page():
    return render_template("wallet.html")


@app.route("/debug/db")
def debug_db():
    return {
        "database_url_exists": bool(chain.storage.database_url),
        "database_url_prefix": chain.storage.database_url[:30] if chain.storage.database_url else None,
        "stored_peers": list(peers),
        "auto_sync_interval": AUTO_SYNC_INTERVAL,
        "faucet_amount": FAUCET_AMOUNT,
        "faucet_cooldown_seconds": FAUCET_COOLDOWN_SECONDS
    }


@app.route("/api")
def api_home():
    return {
        "name": "ZyronChain",
        "blocks": len(chain.chain),
        "pending_transactions": len(chain.pending_transactions),
        "difficulty": chain.difficulty,
        "mining_reward": chain.get_current_reward(),
        "peers": list(peers),
        "valid": chain.is_chain_valid(),
        "auto_sync_interval": AUTO_SYNC_INTERVAL,
        "supply": chain.get_supply_info(),
        "network": chain.get_network_info()
    }


@app.route("/network")
def network():
    return chain.get_network_info()


@app.route("/supply")
def supply():
    return chain.get_supply_info()


@app.route("/chain")
def get_chain():
    return {
        "length": len(chain.chain),
        "chain": [block_to_dict(block) for block in chain.chain],
        "valid": chain.is_chain_valid()
    }


@app.route("/block/<index>")
def block_page(index):
    return chain.get_block(index)


@app.route("/wallet/new")
def new_wallet():
    wallet = Wallet()
    return wallet.to_dict()


@app.route("/wallet/recover", methods=["POST"])
def recover_wallet():
    data = request.json or {}
    mnemonic = data.get("mnemonic")

    if not mnemonic:
        return {
            "message": "Wallet recovery failed",
            "error": "Mnemonic is required"
        }, 400

    wallet = Wallet(mnemonic=mnemonic)

    return {
        "message": "Wallet recovered",
        "wallet": wallet.to_dict()
    }


@app.route("/faucet/<address>")
def faucet(address):
    now = time.time()
    last_claim = storage.get_last_faucet_claim(address)

    if last_claim:
        seconds_since_claim = now - float(last_claim)
        seconds_remaining = FAUCET_COOLDOWN_SECONDS - seconds_since_claim

        if seconds_remaining > 0:
            return {
                "message": "Faucet cooldown active",
                "address": address,
                "allowed": False,
                "seconds_remaining": int(seconds_remaining),
                "hours_remaining": round(seconds_remaining / 3600, 2),
                "balance": chain.get_balance(address),
                "chain_valid": chain.is_chain_valid()
            }, 429

    old_reward = chain.mining_reward
    chain.mining_reward = FAUCET_AMOUNT

    chain.mine_pending_transactions(address)

    chain.mining_reward = old_reward
    storage.save_faucet_claim(address, now)

    return {
        "message": "Faucet sent test ZYN",
        "address": address,
        "amount": FAUCET_AMOUNT,
        "balance": chain.get_balance(address),
        "total_blocks": len(chain.chain),
        "chain_valid": chain.is_chain_valid()
    }


@app.route("/mine/<address>")
def mine(address):
    chain.mine_pending_transactions(address)

    return {
        "message": "Block mined",
        "miner": address,
        "reward": chain.get_current_reward(),
        "difficulty": chain.difficulty,
        "network": chain.get_network_info(),
        "total_supply": chain.get_total_supply(),
        "remaining_supply": chain.get_remaining_supply(),
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
    transactions = chain.get_address_transactions(address)

    return {
        "address": address,
        "balance": chain.get_balance(address),
        "available_balance": chain.get_available_balance(address),
        "transaction_count": len(transactions),
        "transactions": transactions,
        "chain_valid": chain.is_chain_valid()
    }


@app.route("/tx/<txid>")
def transaction_page(txid):
    return chain.get_transaction(txid)


@app.route("/transaction", methods=["POST"])
def transaction():
    data = request.json or {}

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
    tx_data = tx.to_dict()
    broadcast_results = broadcast_transaction(tx_data)

    return {
        "message": "Transaction added to mempool",
        "txid": txid,
        "pending_transactions": len(chain.pending_transactions),
        "broadcast": broadcast_results
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
        tx_data = tx.to_dict()
        broadcast_results = broadcast_transaction(tx_data)

        return {
            "message": "Transfer accepted",
            "txid": txid,
            "sender": tx.sender,
            "receiver": tx.receiver,
            "amount": tx.amount,
            "pending_transactions": len(chain.pending_transactions),
            "broadcast": broadcast_results
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
        tx_data = tx.to_dict()
        broadcast_results = broadcast_transaction(tx_data)

        return {
            "message": "Transfer accepted",
            "txid": txid,
            "sender": sender_wallet.to_dict(),
            "receiver": receiver_wallet.to_dict(),
            "amount": tx.amount,
            "pending_transactions": len(chain.pending_transactions),
            "broadcast": broadcast_results
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
        tx_data = tx.to_dict()
        broadcast_results = broadcast_transaction(tx_data)

        return {
            "message": "Transfer accepted",
            "txid": txid,
            "sender": sender_wallet.address,
            "receiver": receiver_wallet.address,
            "amount": tx.amount,
            "pending_transactions": len(chain.pending_transactions),
            "broadcast": broadcast_results
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


@app.route("/mempool/sync")
def mempool_sync():
    sync_results = []
    total_accepted = 0
    total_rejected = 0

    for node in peers:
        try:
            result = sync_mempool_from_node(node)
            sync_results.append(result)

            mempool_result = result.get("result", {})
            total_accepted += mempool_result.get("accepted", 0)
            total_rejected += mempool_result.get("rejected", 0)

        except Exception as error:
            sync_results.append({
                "node": node,
                "status": "failed",
                "reason": str(error)
            })

    return {
        "message": "Mempool synchronization completed",
        "peers_checked": len(peers),
        "accepted": total_accepted,
        "rejected": total_rejected,
        "pending_transactions": len(chain.pending_transactions),
        "results": sync_results
    }


@app.route("/nodes")
def get_nodes():
    return {
        "nodes": list(peers),
        "count": len(peers)
    }


@app.route("/nodes/register", methods=["POST"])
def register_node():
    data = request.json or {}
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
            result = sync_chain_from_node(node)
            sync_results.append(result)

            chain_result = result.get("result", {})

            if chain_result.get("replaced"):
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


@app.route("/sync/all")
def sync_all():
    chain_results = []
    mempool_results = []

    for node in peers:
        try:
            chain_results.append(sync_chain_from_node(node))
        except Exception as error:
            chain_results.append({
                "node": node,
                "status": "failed",
                "reason": str(error)
            })

        try:
            mempool_results.append(sync_mempool_from_node(node))
        except Exception as error:
            mempool_results.append({
                "node": node,
                "status": "failed",
                "reason": str(error)
            })

    return {
        "message": "Full synchronization completed",
        "chain_results": chain_results,
        "mempool_results": mempool_results,
        "current_length": len(chain.chain),
        "pending_transactions": len(chain.pending_transactions),
        "peers_checked": len(peers)
    }


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)

import os
import requests
import threading
import time
import socket
import ipaddress
from urllib.parse import urlparse
from flask import Flask, request, render_template
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from zyron.blockchain import Blockchain
from zyron.wallet import Wallet
from zyron.transaction import Transaction
from zyron.storage import BlockchainStorage

app = Flask(__name__)

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["300 per hour"]
)

chain = Blockchain()
storage = BlockchainStorage()

peers = set(storage.load_peers())

AUTO_SYNC_INTERVAL = 60
FAUCET_AMOUNT = 25
FAUCET_COOLDOWN_SECONDS = 24 * 60 * 60
MAX_PEERS = 50
PEER_TIMEOUT = 5
MAX_PEER_FAILURES = 3
peer_failures = {}


def normalize_peer_url(node):
    if not isinstance(node, str):
        return None
    return node.strip().rstrip("/")


def is_private_or_local_host(hostname):
    if not hostname:
        return True

    if hostname in ["localhost", "127.0.0.1", "0.0.0.0", "::1"]:
        return True

    try:
        ip = ipaddress.ip_address(hostname)
        return (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_unspecified
        )
    except ValueError:
        pass

    try:
        resolved_ips = socket.getaddrinfo(hostname, None)
        for item in resolved_ips:
            ip_text = item[4][0]
            ip = ipaddress.ip_address(ip_text)
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_multicast
                or ip.is_unspecified
            ):
                return True
    except Exception:
        return True

    return False


def is_valid_peer_url(node):
    node = normalize_peer_url(node)

    if not node:
        return False, "Peer URL is empty"

    parsed = urlparse(node)

    if parsed.scheme != "https":
        return False, "Only https peer URLs are allowed"

    if not parsed.netloc or not parsed.hostname:
        return False, "Invalid peer hostname"

    if parsed.username or parsed.password:
        return False, "Peer URL must not contain username or password"

    if parsed.path not in ["", "/"]:
        return False, "Peer URL must be a base URL only"

    if parsed.query or parsed.fragment:
        return False, "Peer URL must not contain query or fragment"

    if is_private_or_local_host(parsed.hostname):
        return False, "Private, local, or unreachable hosts are not allowed"

    return True, "Valid peer URL"


def add_peer(node):
    node = normalize_peer_url(node)
    valid, reason = is_valid_peer_url(node)

    if not valid:
        return {"added": False, "node": node, "reason": reason}

    if len(peers) >= MAX_PEERS and node not in peers:
        return {"added": False, "node": node, "reason": "Maximum peer limit reached"}

    if node in peers:
        return {"added": False, "node": node, "reason": "Peer already exists"}

    peers.add(node)
    storage.save_peer(node)
    peer_failures[node] = 0

    return {"added": True, "node": node, "reason": "Peer added"}


def remove_peer(node):
    node = normalize_peer_url(node)

    if node in peers:
        peers.remove(node)

    storage.remove_peer(node)

    if node in peer_failures:
        del peer_failures[node]

    return {
        "removed": True,
        "node": node
    }


def record_peer_success(node):
    node = normalize_peer_url(node)
    if node:
        peer_failures[node] = 0


def record_peer_failure(node, reason):
    node = normalize_peer_url(node)

    if not node:
        return {
            "node": node,
            "failure_count": 0,
            "max_failures": MAX_PEER_FAILURES,
            "removed": False,
            "reason": reason
        }

    current_failures = peer_failures.get(node, 0) + 1
    peer_failures[node] = current_failures

    removed = False

    if current_failures >= MAX_PEER_FAILURES:
        remove_peer(node)
        removed = True

    return {
        "node": node,
        "failure_count": current_failures,
        "max_failures": MAX_PEER_FAILURES,
        "removed": removed,
        "reason": reason
    }


def ping_peer(node):
    node = normalize_peer_url(node)
    valid, reason = is_valid_peer_url(node)

    if not valid:
        failure = record_peer_failure(node, reason)
        return {
            "node": node,
            "online": False,
            "failure_score": peer_failures.get(node, 0),
            "failure": failure,
            "reason": reason
        }

    try:
        start = time.time()
        response = requests.get(f"{node}/peer/status", timeout=PEER_TIMEOUT)
        latency_ms = round((time.time() - start) * 1000, 2)

        try:
            data = response.json()
        except Exception:
            data = {"raw_response": response.text[:500]}

        if response.status_code == 200:
            record_peer_success(node)
            online = True
            failure = None
        else:
            failure = record_peer_failure(node, f"HTTP {response.status_code}")
            online = False

        return {
            "node": node,
            "online": online,
            "status_code": response.status_code,
            "latency_ms": latency_ms,
            "failure_score": peer_failures.get(node, 0),
            "failure": failure,
            "response": data
        }

    except Exception as error:
        failure = record_peer_failure(node, str(error))

        return {
            "node": node,
            "online": False,
            "failure_score": peer_failures.get(node, 0),
            "failure": failure,
            "reason": str(error)
        }


if not peers:
    default_peer = "https://zyronchain-node2.onrender.com"
    result = add_peer(default_peer)
    if not result.get("added"):
        print("Default peer skipped:", result)


def sync_chain_from_node(node):
    node = normalize_peer_url(node)
    valid, reason = is_valid_peer_url(node)

    if not valid:
        failure = record_peer_failure(node, reason)
        return {"node": node, "status": "failed", "reason": reason, "failure": failure}

    try:
        response = requests.get(f"{node}/chain", timeout=PEER_TIMEOUT)

        if response.status_code != 200:
            failure = record_peer_failure(node, f"HTTP {response.status_code}")
            return {
                "node": node,
                "status": "failed",
                "reason": f"HTTP {response.status_code}",
                "failure": failure
            }

        data = response.json()
        result = chain.replace_chain(data.get("chain"))
        record_peer_success(node)

        return {
            "node": node,
            "remote_length": data.get("length"),
            "result": result
        }

    except Exception as error:
        failure = record_peer_failure(node, str(error))
        return {"node": node, "status": "failed", "reason": str(error), "failure": failure}


def sync_mempool_from_node(node):
    node = normalize_peer_url(node)
    valid, reason = is_valid_peer_url(node)

    if not valid:
        failure = record_peer_failure(node, reason)
        return {"node": node, "status": "failed", "reason": reason, "failure": failure}

    try:
        response = requests.get(f"{node}/mempool", timeout=PEER_TIMEOUT)

        if response.status_code != 200:
            failure = record_peer_failure(node, f"HTTP {response.status_code}")
            return {
                "node": node,
                "status": "failed",
                "reason": f"HTTP {response.status_code}",
                "failure": failure
            }

        data = response.json()
        remote_transactions = data.get("pending_transactions", [])
        result = chain.sync_mempool(remote_transactions)
        record_peer_success(node)

        return {
            "node": node,
            "remote_pending": len(remote_transactions),
            "result": result
        }

    except Exception as error:
        failure = record_peer_failure(node, str(error))
        return {"node": node, "status": "failed", "reason": str(error), "failure": failure}


def discover_peers_from_node(node):
    node = normalize_peer_url(node)
    valid, reason = is_valid_peer_url(node)

    if not valid:
        failure = record_peer_failure(node, reason)
        return {"node": node, "status": "failed", "reason": reason, "failure": failure}

    try:
        response = requests.get(f"{node}/nodes", timeout=PEER_TIMEOUT)

        if response.status_code != 200:
            failure = record_peer_failure(node, f"HTTP {response.status_code}")
            return {
                "node": node,
                "status": "failed",
                "reason": f"HTTP {response.status_code}",
                "failure": failure
            }

        data = response.json()
        remote_nodes = data.get("nodes", [])

        added = []
        skipped = []

        for remote_node in remote_nodes:
            result = add_peer(remote_node)

            if result.get("added"):
                added.append(result.get("node"))
            else:
                skipped.append(result)

        record_peer_success(node)

        return {
            "node": node,
            "remote_count": len(remote_nodes),
            "added": added,
            "skipped": skipped
        }

    except Exception as error:
        failure = record_peer_failure(node, str(error))
        return {"node": node, "status": "failed", "reason": str(error), "failure": failure}


def broadcast_peer(new_node):
    new_node = normalize_peer_url(new_node)
    results = []

    for node in list(peers):
        if node == new_node:
            continue

        try:
            response = requests.post(
                f"{node}/nodes/register",
                json={"node": new_node},
                timeout=PEER_TIMEOUT
            )

            try:
                response_data = response.json()
            except Exception:
                response_data = {"raw_response": response.text[:500]}

            if response.status_code == 200:
                record_peer_success(node)
            else:
                record_peer_failure(node, f"HTTP {response.status_code}")

            results.append({
                "node": node,
                "status_code": response.status_code,
                "failure_score": peer_failures.get(node, 0),
                "response": response_data
            })

        except Exception as error:
            failure = record_peer_failure(node, str(error))
            results.append({
                "node": node,
                "status": "failed",
                "reason": str(error),
                "failure": failure
            })

    return results


def broadcast_transaction(tx_data):
    results = []

    for node in list(peers):
        try:
            response = requests.post(
                f"{node}/transaction",
                json=tx_data,
                timeout=PEER_TIMEOUT
            )

            try:
                response_data = response.json()
            except Exception:
                response_data = {"raw_response": response.text[:500]}

            if response.status_code in [200, 201]:
                record_peer_success(node)
            else:
                record_peer_failure(node, f"HTTP {response.status_code}")

            results.append({
                "node": node,
                "status_code": response.status_code,
                "failure_score": peer_failures.get(node, 0),
                "response": response_data
            })

        except Exception as error:
            failure = record_peer_failure(node, str(error))
            results.append({
                "node": node,
                "status": "failed",
                "reason": str(error),
                "failure": failure
            })

    return results


def auto_sync_loop():
    while True:
        time.sleep(AUTO_SYNC_INTERVAL)

        for node in list(peers):
            try:
                print("Auto chain sync:", sync_chain_from_node(node))
                print("Auto mempool sync:", sync_mempool_from_node(node))
                print("Auto peer discovery:", discover_peers_from_node(node))
            except Exception as error:
                failure = record_peer_failure(node, str(error))
                print("Auto sync failed:", failure)


sync_thread = threading.Thread(target=auto_sync_loop, daemon=True)
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


@app.route("/health")
def health():
    return {
        "status": "online",
        "name": "ZyronChain",
        "chain_valid": chain.is_chain_valid(),
        "blocks": len(chain.chain),
        "current_block_height": len(chain.chain) - 1,
        "pending_transactions": len(chain.pending_transactions),
        "peers": len(peers),
        "peer_list": list(peers),
        "peer_failures": peer_failures,
        "database_connected": bool(chain.storage.database_url),
        "difficulty": chain.difficulty,
        "auto_sync_interval": AUTO_SYNC_INTERVAL,
        "network": chain.get_network_info(),
        "supply": chain.get_supply_info()
    }


@app.route("/peer/status")
def peer_status():
    return {
        "status": "online",
        "name": "ZyronChain",
        "chain_id": "zyron-testnet-1",
        "chain_valid": chain.is_chain_valid(),
        "height": len(chain.chain) - 1,
        "blocks": len(chain.chain),
        "latest_block_hash": chain.get_latest_block().hash,
        "cumulative_work": chain.get_chain_work(),
        "pending_transactions": len(chain.pending_transactions),
        "peers": len(peers),
        "timestamp": time.time()
    }


@app.route("/peers/health")
def peers_health():
    results = [ping_peer(node) for node in list(peers)]

    online = sum(1 for result in results if result.get("online"))
    offline = len(results) - online

    return {
        "peer_count": len(peers),
        "online": online,
        "offline": offline,
        "peer_failures": peer_failures,
        "results": results
    }


@app.route("/peers/ping", methods=["POST"])
@limiter.limit("20 per minute")
def peers_ping():
    data = request.json or {}
    node = data.get("node")

    if node:
        return ping_peer(node)

    results = [ping_peer(peer) for peer in list(peers)]
    return {"results": results, "peer_failures": peer_failures}


@app.route("/stats")
def stats():
    return chain.get_stats()


@app.route("/richlist")
def richlist():
    return {
        "count": len(chain.get_rich_list()),
        "rich_list": chain.get_rich_list()
    }


@app.route("/latest-transactions")
def latest_transactions():
    return {
        "count": len(chain.get_latest_transactions()),
        "transactions": chain.get_latest_transactions()
    }


@app.route("/miners")
def miners():
    return {
        "count": len(chain.get_mining_leaderboard()),
        "miners": chain.get_mining_leaderboard()
    }


@app.route("/explorer-summary")
def explorer_summary():
    return chain.get_explorer_summary()


@app.route("/nonce/<address>")
def nonce(address):
    if not chain.is_valid_address(address):
        return {
            "message": "Nonce lookup failed",
            "error": "Invalid address",
            "address": address
        }, 400

    return {
        "address": address,
        "current_nonce": chain.get_nonce(address),
        "next_nonce": chain.get_next_nonce(address)
    }


@app.route("/debug/db")
def debug_db():
    return {
        "database_url_exists": bool(chain.storage.database_url),
        "database_url_prefix": chain.storage.database_url[:30] if chain.storage.database_url else None,
        "stored_peers": list(peers),
        "peer_failures": peer_failures,
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
        "peer_failures": peer_failures,
        "valid": chain.is_chain_valid(),
        "auto_sync_interval": AUTO_SYNC_INTERVAL,
        "supply": chain.get_supply_info(),
        "network": chain.get_network_info(),
        "stats": chain.get_stats(),
        "explorer_summary": chain.get_explorer_summary()
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
@limiter.limit("10 per minute")
def recover_wallet():
    data = request.json or {}
    mnemonic = data.get("mnemonic")

    if not mnemonic:
        return {"message": "Wallet recovery failed", "error": "Mnemonic is required"}, 400

    try:
        wallet = Wallet(mnemonic=mnemonic)
        return {"message": "Wallet recovered", "wallet": wallet.to_dict()}
    except Exception as error:
        return {"message": "Wallet recovery failed", "error": str(error)}, 400


@app.route("/faucet/<address>")
@limiter.limit("5 per hour")
def faucet(address):
    try:
        if not chain.is_valid_address(address):
            return {
                "message": "Faucet rejected",
                "error": "Invalid address",
                "address": address
            }, 400

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

    except Exception as error:
        return {"message": "Faucet rejected", "error": str(error)}, 400


@app.route("/mine/<address>")
@limiter.limit("10 per minute")
def mine(address):
    try:
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

    except Exception as error:
        return {
            "message": "Mining rejected",
            "error": str(error),
            "miner": address
        }, 400


@app.route("/balance/<address>")
def balance(address):
    if not chain.is_valid_address(address):
        return {
            "message": "Balance lookup failed",
            "error": "Invalid address",
            "address": address
        }, 400

    return {"address": address, "balance": chain.get_balance(address)}


@app.route("/address/<address>")
def address_page(address):
    if not chain.is_valid_address(address):
        return {
            "message": "Address lookup failed",
            "error": "Invalid address",
            "address": address
        }, 400

    transactions = chain.get_address_transactions(address)

    return {
        "address": address,
        "balance": chain.get_balance(address),
        "available_balance": chain.get_available_balance(address),
        "nonce": chain.get_nonce(address),
        "next_nonce": chain.get_next_nonce(address),
        "transaction_count": len(transactions),
        "transactions": transactions,
        "chain_valid": chain.is_chain_valid()
    }


@app.route("/tx/<txid>")
def transaction_page(txid):
    return chain.get_transaction(txid)


@app.route("/transaction", methods=["POST"])
@limiter.limit("30 per minute")
def transaction():
    data = request.json or {}

    required_fields = [
        "sender",
        "receiver",
        "amount",
        "public_key",
        "signature",
        "timestamp",
        "txid",
        "nonce"
    ]

    for field in required_fields:
        if field not in data:
            return {
                "message": "Transaction rejected",
                "error": f"Missing field: {field}"
            }, 400

    try:
        tx = Transaction(
            version=int(data.get("version", 1)),
            chain_id=data.get("chain_id", "zyron-testnet-1"),
            nonce=int(data["nonce"]),
            sender=data["sender"],
            receiver=data["receiver"],
            amount=float(data["amount"]),
            fee=float(data.get("fee", 0.01)),
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

    except Exception as error:
        return {
            "message": "Transaction rejected",
            "error": str(error)
        }, 400


@app.route("/wallet/send", methods=["POST"])
def wallet_send():
    return {
        "message": "Endpoint disabled",
        "error": "Private keys must never be sent to the server. Use signed transactions via /transaction."
    }, 410


@app.route("/transfer/demo", methods=["POST"])
def transfer_demo():
    data = request.json or {}

    sender_wallet = Wallet()
    receiver_wallet = Wallet()

    tx = Transaction(
        sender=sender_wallet.address,
        receiver=receiver_wallet.address,
        amount=float(data.get("amount", 10)),
        public_key=sender_wallet.get_public_key(),
        nonce=chain.get_next_nonce(sender_wallet.address),
        fee=float(data.get("fee", 0.01))
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
            "fee": tx.fee,
            "nonce": tx.nonce,
            "pending_transactions": len(chain.pending_transactions),
            "broadcast": broadcast_results
        }

    except Exception as error:
        return {"message": "Transfer rejected", "error": str(error)}, 400


@app.route("/test-transfer")
def test_transfer():
    sender_wallet = Wallet()
    receiver_wallet = Wallet()

    tx = Transaction(
        sender=sender_wallet.address,
        receiver=receiver_wallet.address,
        amount=10,
        public_key=sender_wallet.get_public_key(),
        nonce=chain.get_next_nonce(sender_wallet.address),
        fee=0.01
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
            "fee": tx.fee,
            "nonce": tx.nonce,
            "pending_transactions": len(chain.pending_transactions),
            "broadcast": broadcast_results
        }

    except Exception as error:
        return {"message": "Transfer rejected", "error": str(error)}, 400


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

    for node in list(peers):
        result = sync_mempool_from_node(node)
        sync_results.append(result)

        mempool_result = result.get("result", {})
        total_accepted += mempool_result.get("accepted", 0)
        total_rejected += mempool_result.get("rejected", 0)

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
        "count": len(peers),
        "peer_failures": peer_failures
    }


@app.route("/nodes/register", methods=["POST"])
@limiter.limit("10 per hour")
def register_node():
    data = request.json or {}
    node = normalize_peer_url(data.get("node"))

    result = add_peer(node)

    if not result.get("added"):
        return {
            "message": "Node registration rejected",
            "result": result,
            "nodes": list(peers),
            "count": len(peers)
        }, 400

    broadcast_results = broadcast_peer(node)

    return {
        "message": "Node registered",
        "result": result,
        "nodes": list(peers),
        "count": len(peers),
        "broadcast": broadcast_results
    }


@app.route("/peers/discover")
def peers_discover():
    results = []

    for node in list(peers):
        results.append(discover_peers_from_node(node))

    return {
        "message": "Peer discovery completed",
        "peer_count": len(peers),
        "peers": list(peers),
        "peer_failures": peer_failures,
        "results": results
    }


@app.route("/peers/remove", methods=["POST"])
def peers_remove():
    data = request.json or {}
    node = normalize_peer_url(data.get("node"))

    if not node:
        return {"error": "Node address is required"}, 400

    result = remove_peer(node)

    return {
        "message": "Peer removed",
        "result": result,
        "peer_count": len(peers),
        "peers": list(peers)
    }


@app.route("/nodes/sync")
def sync_nodes():
    sync_results = []
    replaced = False

    for node in list(peers):
        result = sync_chain_from_node(node)
        sync_results.append(result)

        chain_result = result.get("result", {})
        if chain_result.get("replaced"):
            replaced = True

    return {
        "message": "Node synchronization completed",
        "replaced": replaced,
        "current_length": len(chain.chain),
        "peers_checked": len(peers),
        "peer_failures": peer_failures,
        "results": sync_results
    }


@app.route("/sync/all")
def sync_all():
    chain_results = []
    mempool_results = []
    peer_results = []

    for node in list(peers):
        chain_results.append(sync_chain_from_node(node))
        mempool_results.append(sync_mempool_from_node(node))
        peer_results.append(discover_peers_from_node(node))

    return {
        "message": "Full synchronization completed",
        "chain_results": chain_results,
        "mempool_results": mempool_results,
        "peer_results": peer_results,
        "current_length": len(chain.chain),
        "pending_transactions": len(chain.pending_transactions),
        "peers_checked": len(peers),
        "peer_count": len(peers),
        "peer_failures": peer_failures
    }


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)

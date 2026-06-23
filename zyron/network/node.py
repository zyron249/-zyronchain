import requests
from zyron.network.message import Message, MessageTypes
from zyron.network.peer import Peer


class P2PNode:
    def __init__(self, node_url, storage=None):
        self.node_url = node_url
        self.storage = storage
        self.peers = {}

        if self.storage:
            for peer_url in self.storage.load_peers():
                self.add_peer(peer_url)

    def add_peer(self, peer_url):
        if not peer_url:
            return False

        if peer_url == self.node_url:
            return False

        if peer_url in self.peers:
            return False

        self.peers[peer_url] = Peer(peer_url)

        if self.storage:
            self.storage.save_peer(peer_url)

        return True

    def remove_peer(self, peer_url):
        if peer_url in self.peers:
            del self.peers[peer_url]

        if self.storage:
            self.storage.remove_peer(peer_url)

    def get_peers(self):
        return [peer.to_dict() for peer in self.peers.values()]

    def send_message(self, peer_url, message):
        try:
            response = requests.post(
                f"{peer_url}/p2p/message",
                json=message.to_dict(),
                timeout=5
            )

            if peer_url in self.peers:
                if response.status_code == 200:
                    self.peers[peer_url].mark_seen()
                else:
                    self.peers[peer_url].mark_failed()

            return {
                "peer": peer_url,
                "status_code": response.status_code,
                "response": response.json()
            }

        except Exception as error:
            if peer_url in self.peers:
                self.peers[peer_url].mark_failed()

            return {
                "peer": peer_url,
                "status": "failed",
                "reason": str(error)
            }

    def broadcast_message(self, message):
        results = []

        for peer_url in list(self.peers.keys()):
            results.append(
                self.send_message(peer_url, message)
            )

        return results

    def ping_peers(self):
        message = Message(
            MessageTypes.PING,
            payload={"node_url": self.node_url},
            sender=self.node_url
        )

        return self.broadcast_message(message)

    def broadcast_transaction(self, tx_data):
        message = Message(
            MessageTypes.NEW_TRANSACTION,
            payload={"transaction": tx_data},
            sender=self.node_url
        )

        return self.broadcast_message(message)

    def broadcast_block(self, block_data):
        message = Message(
            MessageTypes.NEW_BLOCK,
            payload={"block": block_data},
            sender=self.node_url
        )

        return self.broadcast_message(message)

    def request_chain(self, peer_url):
        message = Message(
            MessageTypes.REQUEST_CHAIN,
            payload={},
            sender=self.node_url
        )

        return self.send_message(peer_url, message)

    def request_mempool(self, peer_url):
        message = Message(
            MessageTypes.REQUEST_MEMPOOL,
            payload={},
            sender=self.node_url
        )

        return self.send_message(peer_url, message)

    def discover_peers(self):
        message = Message(
            MessageTypes.PEER_DISCOVERY,
            payload={"known_peers": list(self.peers.keys())},
            sender=self.node_url
        )

        return self.broadcast_message(message)

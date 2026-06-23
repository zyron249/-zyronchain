import time
import uuid


class Message:
    def __init__(self, message_type, payload=None, sender=None, message_id=None, timestamp=None):
        self.message_type = message_type
        self.payload = payload if payload is not None else {}
        self.sender = sender
        self.message_id = message_id if message_id else str(uuid.uuid4())
        self.timestamp = timestamp if timestamp else time.time()

    def to_dict(self):
        return {
            "message_type": self.message_type,
            "payload": self.payload,
            "sender": self.sender,
            "message_id": self.message_id,
            "timestamp": self.timestamp
        }

    @staticmethod
    def from_dict(data):
        return Message(
            message_type=data.get("message_type"),
            payload=data.get("payload", {}),
            sender=data.get("sender"),
            message_id=data.get("message_id"),
            timestamp=data.get("timestamp")
        )


class MessageTypes:
    PING = "PING"
    PONG = "PONG"

    NEW_BLOCK = "NEW_BLOCK"
    NEW_TRANSACTION = "NEW_TRANSACTION"

    REQUEST_CHAIN = "REQUEST_CHAIN"
    CHAIN_RESPONSE = "CHAIN_RESPONSE"

    REQUEST_MEMPOOL = "REQUEST_MEMPOOL"
    MEMPOOL_RESPONSE = "MEMPOOL_RESPONSE"

    PEER_DISCOVERY = "PEER_DISCOVERY"
    PEER_DISCOVERY_RESPONSE = "PEER_DISCOVERY_RESPONSE"

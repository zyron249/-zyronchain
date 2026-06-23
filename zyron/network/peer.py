import time


class Peer:
    def __init__(self, node_url, last_seen=None, failures=0):
        self.node_url = node_url
        self.last_seen = last_seen if last_seen else time.time()
        self.failures = failures

    def mark_seen(self):
        self.last_seen = time.time()
        self.failures = 0

    def mark_failed(self):
        self.failures += 1

    def is_healthy(self, max_failures=3):
        return self.failures < max_failures

    def to_dict(self):
        return {
            "node_url": self.node_url,
            "last_seen": self.last_seen,
            "failures": self.failures,
            "healthy": self.is_healthy()
        }

    @staticmethod
    def from_dict(data):
        return Peer(
            node_url=data.get("node_url"),
            last_seen=data.get("last_seen"),
            failures=data.get("failures", 0)
        )

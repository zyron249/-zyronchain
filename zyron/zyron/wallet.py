import hashlib
import time


def create_wallet_address(name):
    data = f"{name}{time.time()}"
    return "ZYN" + hashlib.sha256(data.encode()).hexdigest()[:32]

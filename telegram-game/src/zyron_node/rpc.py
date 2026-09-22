"""Read-only ZyronChain RPC client.

The canonical L1 exposes REST paths, not JSON-RPC methods. This client may call
only the allowlisted GET routes. It never submits transactions or validator votes.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable
from urllib.parse import urlparse

import httpx

from zyron_node.config import validate_rpc_base
from zyron_node.limits import RateLimitExceeded, hit

log = logging.getLogger("zyron_node.rpc")

ADDRESS_RE = re.compile(r"^ZYN[0-9a-f]{40}$")
TRACKER_ADDRESS = "ZYN" + ("0" * 40)
ALLOWED_EXACT = {"/status", "/healthz", "/readyz", "/protocol", "/rpc-info", "/metrics"}
BALANCE_RE = re.compile(r"^/(balance|nonce)/ZYN[0-9a-f]{40}$")
BLOCKS_RE = re.compile(r"^/blocks\?from=([1-9][0-9]{0,11})&limit=([1-9]|10)$")
RPC_HEADER = {"x-zyron-rpc-version": "1", "accept": "application/json"}

Fetch = Callable[[str, dict[str, str], float], tuple[int, str, dict[str, str]]]


class RpcError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass
class ChainClient:
    base_url: str
    allow_remote: bool
    pool: object | None
    fetch: Fetch
    redis_url: str | None = None
    status_ttl: int = 15
    account_ttl: int = 20
    blocks_ttl: int = 30
    timeout: float = 5.0

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def get_json(self, path: str, *, ttl: int, now: datetime | None = None) -> dict:
        self._assert_allowed(path)
        if not self.base_url:
            raise RpcError("unconfigured", "ZYRON_RPC_URL is not set")
        validate_rpc_base(self.base_url, self.allow_remote)
        now = now or datetime.now(timezone.utc)
        cache_key = self._cache_key(path)
        cached = self._cache_get(cache_key, now)
        if cached is not None:
            cached = dict(cached)
            cached["_cached"] = True
            return cached
        self._limit(now)
        url = self.base_url + path
        try:
            status, body, headers = self.fetch(url, RPC_HEADER, self.timeout)
        except Exception as exc:  # noqa: BLE001 — network failures become a panel error
            log.warning("rpc fetch failed path=%s", path.split("?")[0])
            raise RpcError("unreachable", "Zyron RPC is unreachable") from exc
        if status != 200:
            raise RpcError("bad_status", f"Zyron RPC returned HTTP {status}")
        if len(body) > 1_000_000:
            raise RpcError("too_large", "Zyron RPC response was too large")
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise RpcError("bad_json", "Zyron RPC returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise RpcError("bad_json", "Zyron RPC returned an unexpected payload")
        version = headers.get("x-zyron-rpc-version") or headers.get("X-Zyron-Rpc-Version")
        payload = dict(payload)
        payload["_rpcVersion"] = version
        payload["_cached"] = False
        self._cache_set(cache_key, payload, now + timedelta(seconds=ttl))
        return payload

    def panel(self, address: str | None, now: datetime | None = None) -> dict:
        now = now or datetime.now(timezone.utc)
        notice = (
            "Read-only chain view. Balances are on-chain ZYN atoms from the configured node. "
            "They are not Zyron Points and have no conversion rate."
        )
        if not self.configured:
            return {
                "configured": False,
                "reachable": False,
                "notice": (
                    "No ZYRON_RPC_URL is configured. This repository does not publish a hosted public RPC. "
                    "Point the game at your own loopback devnet if you run one."
                ),
                "wallet": _wallet_shell(address),
                "recentBlocks": [],
            }
        try:
            status = self.get_json("/status", ttl=self.status_ttl, now=now)
            protocol = self.get_json("/protocol", ttl=self.status_ttl, now=now)
            health = self.get_json("/healthz", ttl=self.status_ttl, now=now)
        except (RpcError, RateLimitExceeded) as exc:
            return {
                "configured": True,
                "reachable": False,
                "notice": notice,
                "error": getattr(exc, "message", "RPC limited"),
                "wallet": _wallet_shell(address),
                "recentBlocks": [],
            }
        height = _int(status.get("height"))
        blocks: list[dict] = []
        blocks_ok = False
        if height is not None and height >= 1:
            start = max(1, height - 4)
            try:
                raw_blocks = self.get_json(f"/blocks?from={start}&limit=5", ttl=self.blocks_ttl, now=now)
                blocks = summarize_blocks(raw_blocks.get("blocks"), address)
                blocks_ok = True
            except (RpcError, RateLimitExceeded):
                blocks_ok = False
        wallet = _wallet_shell(address)
        wallet_ok = False
        if address and ADDRESS_RE.fullmatch(address):
            try:
                balance = self.get_json(f"/balance/{address}", ttl=self.account_ttl, now=now)
                nonce = self.get_json(f"/nonce/{address}", ttl=self.account_ttl, now=now)
                atoms = _int(balance.get("balanceAtoms"))
                wallet = {
                    "linked": True,
                    "address": address,
                    "balanceAtoms": str(atoms) if atoms is not None else None,
                    "balanceZyn": format_zyn(atoms) if atoms is not None else None,
                    "nonce": _int(nonce.get("nonce")),
                    "observed": atoms is not None,
                }
                wallet_ok = atoms is not None
            except (RpcError, RateLimitExceeded):
                wallet_ok = False
        return {
            "configured": True,
            "reachable": True,
            "cached": bool(status.get("_cached")),
            "rpcVersion": status.get("_rpcVersion"),
            "chainId": status.get("chainId"),
            "genesisHash": status.get("genesisHash"),
            "height": height,
            "tipHash": status.get("tipHash"),
            "protocol": {
                "currentVersion": protocol.get("currentVersion"),
                "nextVersion": protocol.get("nextVersion"),
            },
            "healthOk": bool(health.get("ok")),
            "wallet": wallet,
            "recentBlocks": blocks,
            "markers": {
                "chain_status": True,
                "chain_blocks": blocks_ok,
                "chain_wallet": wallet_ok,
            },
            "notice": notice,
        }

    def _assert_allowed(self, path: str) -> None:
        if path in ALLOWED_EXACT or BALANCE_RE.fullmatch(path) or BLOCKS_RE.fullmatch(path):
            return
        raise RpcError("path_denied", "RPC path is not allowed")

    def _cache_key(self, path: str) -> str:
        digest = hashlib.sha256(self.base_url.encode("utf-8")).hexdigest()[:16]
        return f"rpc:{digest}:{path}"

    def _limit(self, now: datetime) -> None:
        if self.pool is None:
            return
        hit(self.pool, "rpc:global", 30, 60, now)

    def _cache_get(self, key: str, now: datetime) -> dict | None:
        redis_hit = _redis_get(self.redis_url, key)
        if redis_hit is not None:
            return redis_hit
        if self.pool is None:
            return None
        with self.pool.connection() as conn:
            row = conn.execute(
                "SELECT payload, expires_at FROM chain_cache WHERE cache_key = %s",
                (key,),
            ).fetchone()
        if not row or row["expires_at"] <= now:
            return None
        payload = row["payload"]
        return payload if isinstance(payload, dict) else None

    def _cache_set(self, key: str, payload: dict, expires_at: datetime) -> None:
        stored = {k: v for k, v in payload.items() if not str(k).startswith("_")}
        stored["_rpcVersion"] = payload.get("_rpcVersion")
        _redis_set(self.redis_url, key, stored, max(1, int((expires_at - datetime.now(timezone.utc)).total_seconds())))
        if self.pool is None:
            return
        from psycopg.types.json import Json

        with self.pool.connection() as conn:
            with conn.transaction():
                conn.execute(
                    """
                    INSERT INTO chain_cache (cache_key, payload, expires_at)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (cache_key)
                    DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at
                    """,
                    (key, Json(stored), expires_at),
                )


def httpx_fetch(url: str, headers: dict[str, str], timeout: float) -> tuple[int, str, dict[str, str]]:
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        response = client.get(url, headers=headers)
    return response.status_code, response.text, {k.lower(): v for k, v in response.headers.items()}


def valid_watch_address(address: str) -> bool:
    if not isinstance(address, str) or not ADDRESS_RE.fullmatch(address):
        return False
    if address == TRACKER_ADDRESS:
        return False
    return True


def summarize_blocks(blocks: object, address: str | None) -> list[dict]:
    if not isinstance(blocks, list):
        return []
    summary: list[dict] = []
    for block in blocks[:10]:
        if not isinstance(block, dict):
            continue
        header = block.get("header") if isinstance(block.get("header"), dict) else {}
        txs = block.get("transactions") if isinstance(block.get("transactions"), list) else []
        kinds: dict[str, int] = {}
        involves = False
        for tx in txs:
            if not isinstance(tx, dict):
                continue
            kind = tx.get("kind")
            if isinstance(kind, str) and len(kind) <= 40:
                kinds[kind] = kinds.get(kind, 0) + 1
            if address and address in {tx.get("sender"), tx.get("receiver")}:
                involves = True
        block_hash = block.get("hash")
        summary.append(
            {
                "height": _int(header.get("height")),
                "timestampMs": _int(header.get("timestampMs")),
                "hashPrefix": block_hash[:16] if isinstance(block_hash, str) else None,
                "txCount": len(txs),
                "kinds": kinds,
                "involvesWallet": involves,
            }
        )
    return summary


def format_zyn(atoms: int) -> str:
    sign = "-" if atoms < 0 else ""
    atoms = abs(atoms)
    whole, frac = divmod(atoms, 100_000_000)
    return f"{sign}{whole}.{frac:08d}"


def _wallet_shell(address: str | None) -> dict:
    return {
        "linked": bool(address),
        "address": address,
        "balanceAtoms": None,
        "balanceZyn": None,
        "nonce": None,
        "observed": False,
    }


def _int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _redis_get(url: str | None, key: str) -> dict | None:
    if not url:
        return None
    try:
        import redis

        client = redis.Redis.from_url(url, socket_timeout=0.5, decode_responses=True)
        raw = client.get(_redis_key(key))
        if not raw:
            return None
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else None
    except Exception:  # noqa: BLE001 — cache is optional
        log.warning("redis cache read failed")
        return None


def _redis_set(url: str | None, key: str, payload: dict, ttl: int) -> None:
    if not url:
        return
    try:
        import redis

        client = redis.Redis.from_url(url, socket_timeout=0.5, decode_responses=True)
        client.set(_redis_key(key), json.dumps(payload), ex=max(1, ttl))
    except Exception:  # noqa: BLE001 — cache is optional
        log.warning("redis cache write failed")


def _redis_key(key: str) -> str:
    return "zyron-node:" + key


def assert_no_remote_credentials(url: str) -> None:
    parsed = urlparse(url)
    if parsed.username or parsed.password:
        raise RpcError("credentials", "RPC URL rejected")

"""Signed wallet link for the ZyronChain testnet.

A player proves they hold the key of a ZyronChain address:

1. ``issue_challenge`` stores a one-time nonce bound to the player and Telegram user id, valid for a few minutes,
   and returns the exact message the wallet must sign.
2. The phone wallet (website/app) shows that message, asks for approval and signs
   ``canonicalJson({"domain": LINK_SIGNING_DOMAIN, "payload": {"message": message}})`` with the account key, using
   l1's signature scheme (secp256k1, SHA-256 prehash, compact r||s, low-S). It returns a proof code that holds only
   the nonce, the 64-byte public key and the signature. Keys and recovery phrases never leave the wallet.
3. ``verify_proof`` burns the nonce (every attempt, good or bad), verifies the signature, derives the address from
   the public key exactly like l1 (``"ZYN" + sha256(pubkey64)[:40]``) and stores the link.

The reward is a one-time cosmetic badge. It never pays Zyron Points and cannot mint ZYN.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from datetime import datetime, timedelta, timezone

from zyron_node.game import (
    GameError,
    audit,
    enforce_wallet_churn,
    iso,
    lock_player,
    reject_if_banned,
)

LINK_SIGNING_DOMAIN = "zyronchain/game/wallet-link/v1"
PROOF_PREFIX = "zyronlink1"
TESTNET_CHAIN_ID = "zyron-wallet-testnet-1"
CHALLENGE_TTL = timedelta(minutes=10)
WALLET_APP_URL = "https://zyronchain.com/app/"
BADGE_ID = "verified_link"
BADGE_TITLE = "Verified wallet badge"
BADGE_DETAIL = "Shown on your card after you prove a ZyronChain testnet address with a signature."

NONCE_RE = re.compile(r"^[0-9a-f]{32}$")
PUBLIC_KEY_RE = re.compile(r"^[0-9a-f]{128}$")
SIGNATURE_RE = re.compile(r"^[0-9a-f]{128}$")
PROOF_RE = re.compile(r"^zyronlink1\.([0-9a-f]{32})\.([0-9a-f]{128})\.([0-9a-f]{128})$")

# ---------------------------------------------------------------- secp256k1 (verify only, public data)
_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)


def _on_curve(point) -> bool:
    x, y = point
    return 0 <= x < _P and 0 <= y < _P and (y * y - x * x * x - 7) % _P == 0


def _add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0]:
        if (a[1] + b[1]) % _P == 0:
            return None
        slope = 3 * a[0] * a[0] * pow(2 * a[1], -1, _P) % _P
    else:
        slope = (b[1] - a[1]) * pow(b[0] - a[0], -1, _P) % _P
    x = (slope * slope - a[0] - b[0]) % _P
    return x, (slope * (a[0] - x) - a[1]) % _P


def _mul(k: int, point):
    result = None
    addend = point
    while k:
        if k & 1:
            result = _add(result, addend)
        addend = _add(addend, addend)
        k >>= 1
    return result


def canonical_json(value) -> str:
    """Same bytes as l1/website ``canonicalJson`` for plain string/int objects (sorted keys, no spaces)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def link_signing_bytes(message: str) -> bytes:
    return canonical_json({"domain": LINK_SIGNING_DOMAIN, "payload": {"message": message}}).encode("utf-8")


def address_from_public_key(public_key_hex: str) -> str:
    return "ZYN" + hashlib.sha256(bytes.fromhex(public_key_hex)).hexdigest()[:40]


def verify_signature(message_bytes: bytes, signature_hex: str, public_key_hex: str) -> bool:
    """secp256k1 ECDSA over SHA-256(message), compact 64-byte r||s, low-S required (l1 verifyCanonical)."""
    if not SIGNATURE_RE.match(signature_hex or "") or not PUBLIC_KEY_RE.match(public_key_hex or ""):
        return False
    r = int(signature_hex[:64], 16)
    s = int(signature_hex[64:], 16)
    if not (1 <= r < _N and 1 <= s <= _N // 2):
        return False
    q = (int(public_key_hex[:64], 16), int(public_key_hex[64:], 16))
    if not _on_curve(q):
        return False
    e = int.from_bytes(hashlib.sha256(message_bytes).digest(), "big") % _N
    w = pow(s, -1, _N)
    point = _add(_mul(e * w % _N, _G), _mul(r * w % _N, q))
    return point is not None and point[0] % _N == r


def parse_proof(proof: str) -> tuple[str, str, str]:
    match = PROOF_RE.match((proof or "").strip())
    if not match:
        raise GameError(
            "bad_proof",
            "Proof code is not valid. Copy the whole code from the ZyronChain wallet (it starts with zyronlink1.).",
            400,
        )
    return match.group(1), match.group(2), match.group(3)


def _stamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_message(telegram_id: int, nonce: str, issued: datetime, expires: datetime) -> str:
    return "\n".join(
        [
            "ZYRON NODE wallet link (TESTNET)",
            f"Telegram user: {telegram_id}",
            f"Network: {TESTNET_CHAIN_ID}",
            f"Nonce: {nonce}",
            f"Issued: {_stamp(issued)}",
            f"Expires: {_stamp(expires)}",
            "Signing proves you hold this testnet address. It is not a transaction: it moves no funds,",
            "grants no tokens and cannot be used on-chain.",
        ]
    )


def challenge_view(row) -> dict:
    return {
        "nonce": row["nonce"],
        "message": row["message"],
        "domain": LINK_SIGNING_DOMAIN,
        "network": TESTNET_CHAIN_ID,
        "testnet": True,
        "expiresAt": iso(row["expires_at"]),
    }


def issue_challenge(pool, player_id: int, telegram_id: int, now: datetime) -> dict:
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            reject_if_banned(player)
            # Only the newest challenge can be used: older open ones are retired.
            conn.execute(
                "UPDATE wallet_challenges SET used_at = %s, outcome = 'superseded' WHERE player_id = %s AND used_at IS NULL",
                (now, player_id),
            )
            conn.execute("DELETE FROM wallet_challenges WHERE created_at < %s", (now - timedelta(days=7),))
            nonce = secrets.token_hex(16)
            issued = now.replace(microsecond=0)
            expires = issued + CHALLENGE_TTL
            message = build_message(telegram_id, nonce, issued, expires)
            row = conn.execute(
                """
                INSERT INTO wallet_challenges (nonce, player_id, telegram_id, message, created_at, expires_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (nonce, player_id, telegram_id, message, issued, expires),
            ).fetchone()
            return challenge_view(row)


def _finish(conn, nonce: str, outcome: str, address: str | None = None) -> None:
    conn.execute(
        "UPDATE wallet_challenges SET outcome = %s, address = COALESCE(%s, address) WHERE nonce = %s",
        (outcome, address, nonce),
    )


def verify_proof(pool, player_id: int, telegram_id: int, proof: str, now: datetime) -> dict:
    nonce, public_key, signature = parse_proof(proof)
    failure: GameError | None = None
    message = None
    with pool.connection() as conn:
        # Step 1: burn the nonce in its own transaction so a failed attempt can never be retried.
        with conn.transaction():
            row = conn.execute("SELECT * FROM wallet_challenges WHERE nonce = %s FOR UPDATE", (nonce,)).fetchone()
            if row is None or int(row["player_id"]) != player_id or int(row["telegram_id"]) != telegram_id:
                failure = GameError("challenge_unknown", "This proof was not issued to your account. Start Connect wallet again.", 400)
            elif row["used_at"] is not None:
                failure = GameError("challenge_used", "This proof was already used. Start Connect wallet again.", 409)
            elif row["expires_at"] <= now:
                conn.execute("UPDATE wallet_challenges SET used_at = %s, outcome = 'expired' WHERE nonce = %s", (now, nonce))
                failure = GameError("challenge_expired", "This proof expired. Start Connect wallet again.", 410)
            else:
                conn.execute("UPDATE wallet_challenges SET used_at = %s, outcome = 'checking' WHERE nonce = %s", (now, nonce))
                message = row["message"]
        if failure is not None:
            raise failure

        address = address_from_public_key(public_key)
        if not verify_signature(link_signing_bytes(message), signature, public_key):
            with conn.transaction():
                _finish(conn, nonce, "bad_signature")
            raise GameError("bad_signature", "Signature check failed. Start Connect wallet again.", 400)

        # Step 2: store the link.
        try:
            with conn.transaction():
                response = _store_link(conn, player_id, address, now)
                _finish(conn, nonce, "linked", address)
                return response
        except GameError as exc:
            with conn.transaction():
                _finish(conn, nonce, exc.code[:32] if re.fullmatch(r"[a-z_]{1,32}", exc.code) else "rejected", address)
            raise


def _store_link(conn, player_id: int, address: str, now: datetime) -> dict:
    player = lock_player(conn, player_id)
    reject_if_banned(player)
    already = player["wallet_address"] == address and player.get("wallet_verified_at") is not None
    if not already:
        enforce_wallet_churn(conn, player_id, now)
    claim = conn.execute(
        "SELECT player_id, verified_at FROM wallet_claims WHERE address = %s FOR UPDATE", (address,)
    ).fetchone()
    superseded = None
    if claim and int(claim["player_id"]) != player_id:
        if claim["verified_at"] is not None:
            raise GameError("address_taken", "That address is already verified by another account.", 409)
        # An unverified watch-only claim yields to the key holder.
        superseded = int(claim["player_id"])
        conn.execute(
            "UPDATE players SET wallet_address = NULL, wallet_linked_at = NULL, wallet_verified_at = NULL WHERE id = %s AND wallet_address = %s",
            (superseded, address),
        )
        conn.execute(
            "INSERT INTO wallet_events (player_id, address, action, created_at) VALUES (%s, %s, 'superseded', %s)",
            (superseded, address, now),
        )
        conn.execute("DELETE FROM wallet_claims WHERE address = %s", (address,))
        claim = None
    if claim is None:
        conn.execute(
            "INSERT INTO wallet_claims (address, player_id, claimed_at, verified_at) VALUES (%s, %s, %s, %s)",
            (address, player_id, now, now),
        )
    else:
        conn.execute("UPDATE wallet_claims SET verified_at = COALESCE(verified_at, %s) WHERE address = %s", (now, address))
    conn.execute(
        "UPDATE players SET wallet_address = %s, wallet_linked_at = %s, wallet_verified_at = %s WHERE id = %s",
        (address, now if player["wallet_address"] != address else player["wallet_linked_at"] or now, now, player_id),
    )
    if not already:
        conn.execute(
            "INSERT INTO wallet_events (player_id, address, action, created_at) VALUES (%s, %s, 'verify', %s)",
            (player_id, address, now),
        )
    badge = conn.execute(
        """
        INSERT INTO player_cosmetics (player_id, cosmetic_id, source, acquired_at)
        VALUES (%s, %s, 'wallet_proof', %s)
        ON CONFLICT DO NOTHING
        RETURNING cosmetic_id
        """,
        (player_id, BADGE_ID, now),
    ).fetchone()
    if superseded is not None:
        audit(conn, "system", "wallet.superseded", {"address": address, "from": superseded, "to": player_id}, now)
    return {
        "linked": True,
        "verified": True,
        "address": address,
        "unchanged": already,
        "testnet": True,
        "network": TESTNET_CHAIN_ID,
        "badge": {"id": BADGE_ID, "title": BADGE_TITLE, "detail": BADGE_DETAIL, "new": badge is not None},
        "pointsGranted": 0,
        "serverTime": iso(now),
    }

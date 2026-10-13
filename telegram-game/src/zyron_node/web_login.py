"""Read-only web sign-in for ZYRON HUB.

Flow (no client-supplied ids are ever trusted):

1. ``start_login``: the browser asks for a login request. The server returns a public ``loginId`` (used in the
   ``t.me/<bot>?start=web_<loginId>`` deep link) and a random ``secret`` that only that browser holds. Valid 120 s.
2. ``bot_confirm``: the user opens the deep link in Telegram. The bot (authenticated by Telegram itself) binds the
   request to the sender's Telegram id and sends a one-time code in that private chat. The code is valid 120 s.
   Someone who tricks a victim into opening a link never sees the code, so the browser that started the request
   cannot finish without the person who received the code typing it in.
3. ``finish_login``: the browser presents ``loginId`` + ``secret`` + ``code``. Every attempt counts; a request is
   burned on success, after 5 wrong codes, or on expiry. The result is a random session token (30 min) that the
   browser keeps in memory only and sends as ``Authorization: zws <token>``. No cookies, so no CSRF surface.

Only SHA-256 hashes of the secret, the code and the token are stored. Sessions are read-only.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta

from zyron_node.game import ALPHABET, GameError

LOGIN_TTL_SECONDS = 120
CODE_TTL_SECONDS = 120
SESSION_TTL_SECONDS = 30 * 60
MAX_CODE_ATTEMPTS = 5
START_PREFIX = "web_"
LOGIN_ID_RE = re.compile(r"^[0-9a-f]{32}$")
SECRET_RE = re.compile(r"^[0-9a-f]{64}$")
CODE_LEN = 8


def _h(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_code(raw: str) -> str:
    return re.sub(r"[\s-]", "", raw or "").upper()


def login_id_from_param(argument: str) -> str | None:
    token = (argument or "").split()[0] if (argument or "").split() else ""
    if not token.startswith(START_PREFIX):
        return None
    login_id = token[len(START_PREFIX):]
    return login_id if LOGIN_ID_RE.match(login_id) else None


def start_login(pool, now: datetime, bot_username: str) -> dict:
    login_id = secrets.token_hex(16)
    secret = secrets.token_hex(32)
    expires = now + timedelta(seconds=LOGIN_TTL_SECONDS)
    with pool.connection() as conn:
        with conn.transaction():
            conn.execute(
                "INSERT INTO web_logins (login_id, secret_hash, created_at, expires_at) VALUES (%s, %s, %s, %s)",
                (login_id, _h(secret), now, expires),
            )
            if secrets.randbelow(20) == 0:
                conn.execute("DELETE FROM web_logins WHERE created_at < %s", (now - timedelta(days=1),))
                conn.execute("DELETE FROM web_sessions WHERE expires_at < %s", (now - timedelta(days=1),))
    bot = (bot_username or "ZyronNodeBot").lstrip("@")
    return {
        "loginId": login_id,
        "secret": secret,
        "botLink": f"https://t.me/{bot}?start={START_PREFIX}{login_id}",
        "expiresAt": expires.isoformat().replace("+00:00", "Z"),
        "ttlSeconds": LOGIN_TTL_SECONDS,
    }


def bot_confirm(pool, telegram_id: int, login_id: str, now: datetime) -> dict:
    """Called only from the bot, with the Telegram id taken from the authenticated update."""
    if telegram_id <= 0 or not LOGIN_ID_RE.match(login_id or ""):
        return {"ok": False, "text": "This sign-in link is not valid. Start again on zyronchain.com/hub."}
    code = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LEN))
    with pool.connection() as conn:
        with conn.transaction():
            row = conn.execute("SELECT * FROM web_logins WHERE login_id = %s FOR UPDATE", (login_id,)).fetchone()
            if row is None or row["used_at"] is not None or row["expires_at"] <= now:
                return {"ok": False, "text": "This sign-in link has expired or was already used. Start again on zyronchain.com/hub."}
            if row["telegram_id"] is not None:
                # A request is bound once. A second confirmation (by anyone) burns it.
                conn.execute(
                    "UPDATE web_logins SET used_at = %s, outcome = 'double_confirm' WHERE login_id = %s",
                    (now, login_id),
                )
                return {"ok": False, "text": "This sign-in link was already confirmed, so it is now closed. Start again on zyronchain.com/hub."}
            conn.execute(
                """
                UPDATE web_logins SET telegram_id = %s, code_hash = %s, code_issued_at = %s, code_expires_at = %s
                WHERE login_id = %s
                """,
                (telegram_id, _h(code), now, now + timedelta(seconds=CODE_TTL_SECONDS), login_id),
            )
    shown = f"{code[:4]}-{code[4:]}"
    return {
        "ok": True,
        "code": code,
        "text": (
            "ZYRON HUB web sign-in\n\n"
            f"Your one-time code: {shown}\n\n"
            "Type it only on zyronchain.com/hub, in the browser where you pressed Sign in. It expires in 2 minutes "
            "and works once. Never share it with anyone. The web view is read-only; gameplay stays here in Telegram.\n\n"
            "If you did not start a sign-in, ignore this message."
        ),
    }


def finish_login(pool, login_id: str, secret: str, code: str, now: datetime) -> dict:
    if not LOGIN_ID_RE.match(login_id or "") or not SECRET_RE.match(secret or ""):
        raise GameError("login_invalid", "Sign-in request is not valid.", 400)
    code = normalize_code(code)
    # Burns and attempt counters must be committed even when the request fails, so the error is raised only after
    # the transaction has committed (raising inside it would roll the counter back and allow unlimited guesses).
    error: GameError | None = None
    token = None
    expires = None
    with pool.connection() as conn:
        with conn.transaction():
            row = conn.execute("SELECT * FROM web_logins WHERE login_id = %s FOR UPDATE", (login_id,)).fetchone()
            if row is None or not hmac.compare_digest(row["secret_hash"], _h(secret)):
                error = GameError("login_invalid", "Sign-in request is not valid.", 400)
            elif row["used_at"] is not None:
                error = GameError("login_used", "This sign-in was already used or closed. Start again.", 410)
            elif row["telegram_id"] is None:
                if row["expires_at"] <= now:
                    conn.execute("UPDATE web_logins SET used_at = %s, outcome = 'expired' WHERE login_id = %s", (now, login_id))
                    error = GameError("login_expired", "This sign-in expired. Start again.", 410)
                else:
                    error = GameError("login_pending", "Open the Telegram link first to receive your code.", 409)
            elif row["code_expires_at"] <= now:
                conn.execute("UPDATE web_logins SET used_at = %s, outcome = 'expired' WHERE login_id = %s", (now, login_id))
                error = GameError("login_expired", "This code expired. Start again.", 410)
            else:
                attempts = int(row["attempts"]) + 1
                if len(code) != CODE_LEN or not hmac.compare_digest(row["code_hash"], _h(code)):
                    burned = attempts >= MAX_CODE_ATTEMPTS
                    conn.execute(
                        "UPDATE web_logins SET attempts = %s, used_at = %s, outcome = %s WHERE login_id = %s",
                        (attempts, now if burned else None, "too_many_attempts" if burned else None, login_id),
                    )
                    error = (GameError("login_used", "Too many wrong codes. This sign-in is closed. Start again.", 410)
                             if burned else GameError("login_code", "That code is not correct.", 400))
                else:
                    conn.execute(
                        "UPDATE web_logins SET attempts = %s, used_at = %s, outcome = 'ok' WHERE login_id = %s",
                        (attempts, now, login_id),
                    )
                    token = secrets.token_hex(32)
                    expires = now + timedelta(seconds=SESSION_TTL_SECONDS)
                    conn.execute(
                        "INSERT INTO web_sessions (token_hash, telegram_id, created_at, expires_at) VALUES (%s, %s, %s, %s)",
                        (_h(token), int(row["telegram_id"]), now, expires),
                    )
    if error is not None:
        raise error
    return {"token": token, "expiresAt": expires.isoformat().replace("+00:00", "Z"), "ttlSeconds": SESSION_TTL_SECONDS}


def session_telegram_id(pool, header: str, now: datetime) -> int:
    token = header[4:].strip() if header.startswith("zws ") else ""
    if not SECRET_RE.match(token):
        raise GameError("web_session", "Sign in again.", 401)
    with pool.connection() as conn:
        row = conn.execute("SELECT telegram_id, expires_at, revoked_at FROM web_sessions WHERE token_hash = %s", (_h(token),)).fetchone()
    if row is None or row["revoked_at"] is not None or row["expires_at"] <= now:
        raise GameError("web_session", "Sign in again.", 401)
    return int(row["telegram_id"])


def revoke(pool, header: str, now: datetime) -> dict:
    token = header[4:].strip() if header.startswith("zws ") else ""
    if SECRET_RE.match(token):
        with pool.connection() as conn:
            with conn.transaction():
                conn.execute("UPDATE web_sessions SET revoked_at = %s WHERE token_hash = %s AND revoked_at IS NULL", (now, _h(token)))
    return {"ok": True}


def web_profile(pool, telegram_id: int, now: datetime, bot_username: str) -> dict:
    """Read-only view of the signed-in player's own records. It never writes (no energy persist, no rewards)."""
    from zyron_node.economy import MODULE_ORDER, MODULES, apply_energy
    from zyron_node.game import achievements_view, build_profile, load_levels

    with pool.connection() as conn:
        with conn.transaction():
            conn.execute("SET TRANSACTION READ ONLY")
            row = conn.execute("SELECT * FROM players WHERE telegram_id = %s", (telegram_id,)).fetchone()
            if row is None:
                raise GameError("no_player", "Open ZYRON NODE in Telegram once to create your profile.", 404)
            levels = load_levels(conn, int(row["id"]))
            player = dict(row)
            player["energy"], player["energy_updated_at"] = apply_energy(int(row["energy"]), row["energy_updated_at"], now, levels)
            profile = build_profile(conn, player, levels, now, bot_username)
    achievements = achievements_view(pool, int(row["id"]))["achievements"]
    p = profile["player"]
    return {
        "readOnly": True,
        "profile": {
            "displayName": p["displayName"],
            "username": p["username"],
            "level": p["level"],
            "tier": p.get("tier"),
            "banned": p["banned"],
            "teamAccount": p["teamAccount"],
            "teamNote": p["teamNote"],
            "cycleCount": p["cycleCount"],
            "networkPower": p["networkPower"],
            "streak": {"count": p["streak"]["count"], "longest": p["streak"]["longest"]},
        },
        "points": {"balance": p["points"], "lifetime": p["lifetimePoints"], "dailyPoints": p["dailyPoints"]},
        "energy": p["energy"],
        "upgrades": [
            {"module": m, "name": MODULES[m].title, "level": int(levels[m]), "maxLevel": int(MODULES[m].max_level)}
            for m in MODULE_ORDER
        ],
        "achievements": {
            "unlocked": sum(1 for a in achievements if a["unlocked"]),
            "total": len(achievements),
            "items": [{"title": a["title"], "unlocked": a["unlocked"], "current": a["current"], "target": a["target"]} for a in achievements],
        },
        "rank": p["rank"],
        "invites": {"invited": p["referral"]["invited"], "qualified": p["referral"]["qualified"], "link": p["referral"]["link"]},
        "wallet": {"linked": bool(p["walletAddress"]), "verified": p["walletVerified"], "address": p["walletAddress"]},
        "season": profile["season"],
        "notices": profile["notices"],
        "serverTime": profile["serverTime"],
    }

"""Telegram WebApp initData verification. The bot token never leaves the server."""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import parse_qsl


class AuthError(Exception):
    def __init__(self, code: str, message: str = "Unauthorized"):
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class TelegramIdentity:
    id: int
    username: str | None
    display_name: str
    start_param: str | None


def verify_init_data(init_data: str, bot_token: str, now: datetime, max_age_seconds: int) -> TelegramIdentity:
    if not bot_token:
        raise AuthError("bot_unconfigured", "Bot token is not configured")
    if not init_data or len(init_data) > 4096:
        raise AuthError("bad_init_data", "Invalid Telegram init data")
    try:
        pairs = parse_qsl(init_data, strict_parsing=True, keep_blank_values=True)
    except ValueError as exc:
        raise AuthError("bad_init_data", "Invalid Telegram init data") from exc
    data: dict[str, str] = {}
    for key, value in pairs:
        if key in data:
            raise AuthError("bad_init_data", "Invalid Telegram init data")
        data[key] = value
    received = data.pop("hash", None)
    if not received or len(received) != 64:
        raise AuthError("bad_init_data", "Invalid Telegram init data")
    check_string = "\n".join(f"{key}={data[key]}" for key in sorted(data))
    secret = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    computed = hmac.new(secret, check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(computed, received):
        raise AuthError("bad_hash", "Invalid Telegram init data")
    try:
        auth_date = int(data.get("auth_date", ""))
    except ValueError as exc:
        raise AuthError("bad_init_data", "Invalid Telegram init data") from exc
    now_ts = int(now.timestamp())
    if auth_date > now_ts + 30:
        raise AuthError("bad_auth_date", "Invalid Telegram init data")
    if now_ts - auth_date > max_age_seconds:
        raise AuthError("expired", "Telegram session expired")
    try:
        user = json.loads(data.get("user", ""))
    except json.JSONDecodeError as exc:
        raise AuthError("bad_init_data", "Invalid Telegram init data") from exc
    if not isinstance(user, dict) or not isinstance(user.get("id"), int) or isinstance(user.get("id"), bool):
        raise AuthError("bad_init_data", "Invalid Telegram init data")
    if user["id"] <= 0:
        raise AuthError("bad_init_data", "Invalid Telegram init data")
    display = _clean_name(" ".join(
        part for part in (str(user.get("first_name") or ""), str(user.get("last_name") or "")) if part
    ))
    username = user.get("username")
    if username is not None and (not isinstance(username, str) or len(username) > 64):
        username = None
    start_param = data.get("start_param")
    if start_param is not None and (len(start_param) > 64 or not start_param.replace("_", "").isalnum()):
        start_param = None
    return TelegramIdentity(
        id=user["id"],
        username=username,
        display_name=display or "Operator",
        start_param=start_param,
    )


def admin_authorized(presented: str, expected: str) -> bool:
    if not expected or not presented:
        return False
    return hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))


def _clean_name(value: str) -> str:
    cleaned = "".join(ch for ch in value if ch.isprintable())
    return cleaned.strip()[:64]


def hash_ip(ip: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}|{ip}".encode("utf-8")).hexdigest()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)

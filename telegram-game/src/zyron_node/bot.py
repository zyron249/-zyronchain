"""Telegram bot for /start /play /profile /rank /invite /help and the Play Zyron menu button.

This process does not change group permissions, history, admins, or other bots.
"""

from __future__ import annotations

import logging
import signal
import threading
from datetime import datetime, timezone

import httpx

from zyron_node.auth import TelegramIdentity
from zyron_node.config import load_settings, validate_settings
from zyron_node.db import create_pool, migrate
from zyron_node.economy import POINTS_NOTICE
from zyron_node.game import invite_link, leaderboard_view, open_session, referral_code_from_param, remember_pending_referral
from zyron_node.logging_setup import setup_logging

log = logging.getLogger("zyron_node.bot")

COMMANDS = [
    {"command": "start", "description": "Open ZYRON NODE"},
    {"command": "play", "description": "Play in the Mini App"},
    {"command": "profile", "description": "Your node profile"},
    {"command": "rank", "description": "Leaderboard snapshot"},
    {"command": "invite", "description": "Your referral link"},
    {"command": "help", "description": "How the game works"},
]


def parse_command(text: str) -> tuple[str, str]:
    parts = (text or "").strip().split(maxsplit=1)
    if not parts or not parts[0].startswith("/"):
        return "", ""
    command = parts[0].split("@", 1)[0][1:].lower()
    argument = parts[1].strip() if len(parts) > 1 else ""
    return command, argument


def play_markup(webapp_url: str) -> dict | None:
    if webapp_url.startswith("https://"):
        return {"inline_keyboard": [[{"text": "Play Zyron", "web_app": {"url": webapp_url}}]]}
    return None


def menu_button_payload(webapp_url: str) -> dict:
    if webapp_url.startswith("https://"):
        return {"menu_button": {"type": "web_app", "text": "Play Zyron", "web_app": {"url": webapp_url}}}
    return {"menu_button": {"type": "commands"}}


def reply_for(command: str, argument: str, profile: dict | None, webapp_url: str) -> dict:
    markup = play_markup(webapp_url)
    if command in {"", "start", "play"}:
        text = (
            "ZYRON NODE\n\n"
            "Run a fictional community node. Earn off-chain Zyron Points, keep your energy topped up, "
            "and climb the season board.\n\n"
            f"{POINTS_NOTICE}"
        )
        if command == "start" and argument:
            text += "\n\nReferral noted if the code is valid."
    elif command == "help":
        text = (
            "Commands: /play /profile /rank /invite /help\n\n"
            "Energy regenerates on server time. Upgrades spend Zyron Points. "
            "Linking a wallet stores only a public ZYN address — never a seed or private key.\n\n"
            f"{POINTS_NOTICE}"
        )
    elif command == "profile":
        player = (profile or {}).get("player") or {}
        energy = player.get("energy") or {}
        text = (
            f"{player.get('displayName', 'Operator')} · level {player.get('level', 1)}\n"
            f"Zyron Points: {player.get('points', 0)}\n"
            f"Energy: {energy.get('current', 0)}/{energy.get('max', 0)}\n"
            f"Network Power: {player.get('networkPower', 0)}\n"
            f"Streak: {((player.get('streak') or {}).get('count', 0))} days"
        )
    elif command == "rank":
        text = "Leaderboards are Daily, Weekly, Season, and All-time inside the Mini App."
        if profile and profile.get("top"):
            lines = [f"{row['rank']}. {row['displayName']} — {row['score']}" for row in profile["top"]]
            text = "All-time Zyron Points\n" + "\n".join(lines)
    elif command == "invite":
        referral = ((profile or {}).get("player") or {}).get("referral") or {}
        text = f"Invite link: {referral.get('link') or 'Open the Mini App once, then use /invite.'}"
    else:
        text = "Unknown command. Try /help."
        markup = None
    payload = {"text": text}
    if markup:
        payload["reply_markup"] = markup
    return payload


def run_bot(stop: threading.Event) -> None:
    settings = load_settings()
    validate_settings(settings)
    setup_logging(settings.log_level)
    if not settings.telegram_bot_token:
        raise SystemExit("TELEGRAM_BOT_TOKEN is required to run the bot")
    pool = create_pool(settings.database_url)
    migrate(pool)
    token = settings.telegram_bot_token
    try:
        telegram_call(token, "setMyCommands", {"commands": COMMANDS})
        telegram_call(token, "setChatMenuButton", menu_button_payload(settings.webapp_url))
        log.info("telegram commands and Play Zyron menu button registered")
        offset = None
        while not stop.is_set():
            payload: dict = {"timeout": 25}
            if offset is not None:
                payload["offset"] = offset
            try:
                body = telegram_call(token, "getUpdates", payload, timeout=35)
            except Exception:  # noqa: BLE001 — keep polling through transient API errors
                log.warning("telegram getUpdates failed")
                stop.wait(3)
                continue
            for update in body.get("result", []):
                offset = int(update["update_id"]) + 1
                message = update.get("message") or {}
                text = message.get("text") or ""
                user = message.get("from") or {}
                chat = message.get("chat") or {}
                if not user.get("id") or not chat.get("id") or not text.startswith("/"):
                    continue
                command, argument = parse_command(text)
                if command not in {"start", "play", "profile", "rank", "invite", "help"}:
                    continue
                reply = handle_private_command(pool, settings, user, command, argument)
                reply["chat_id"] = chat["id"]
                try:
                    telegram_call(token, "sendMessage", reply)
                except Exception:  # noqa: BLE001
                    log.warning("telegram sendMessage failed")
    finally:
        pool.close()


def handle_private_command(pool, settings, user: dict, command: str, argument: str) -> dict:
    start_param = None
    if command == "start" and argument:
        token = argument.split()[0][:64]
        code = referral_code_from_param(token)
        if code:
            start_param = "ref_" + code
            remember_pending_referral(pool, int(user["id"]), code, datetime.now(timezone.utc))
    identity = TelegramIdentity(
        id=int(user["id"]),
        username=user.get("username") if isinstance(user.get("username"), str) else None,
        display_name=_display(user),
        start_param=start_param,
    )
    now = datetime.now(timezone.utc)
    try:
        profile = open_session(pool, identity, None, now, settings.telegram_bot_username)
        if command == "rank":
            board = leaderboard_view(pool, int(profile["player"]["id"]), "alltime", now, limit=5)
            profile = dict(profile)
            profile["top"] = board["entries"]
    except Exception:  # noqa: BLE001 — the chat should still get a safe reply
        log.warning("profile lookup failed")
        profile = None
    reply = reply_for(command, argument, profile, settings.webapp_url)
    if command == "invite" and profile:
        reply["text"] = "Invite operators with:\n" + invite_link(
            settings.telegram_bot_username, profile["player"]["referral"]["code"]
        )
    return reply


def telegram_call(token: str, method: str, payload: dict, timeout: float = 15) -> dict:
    response = httpx.post(f"https://api.telegram.org/bot{token}/{method}", json=payload, timeout=timeout)
    if response.status_code >= 400:
        log.warning("telegram %s http %s", method, response.status_code)
        raise RuntimeError(f"telegram {method} failed")
    body = response.json()
    if not body.get("ok"):
        log.warning("telegram %s rejected", method)
        raise RuntimeError(f"telegram {method} rejected")
    return body


def _display(user: dict) -> str:
    parts = [str(user.get("first_name") or ""), str(user.get("last_name") or "")]
    name = " ".join(part for part in parts if part).strip()
    cleaned = "".join(ch for ch in name if ch.isprintable())
    return cleaned[:64] or "Operator"


def main() -> None:
    stop = threading.Event()

    def _stop(_signum, _frame) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    run_bot(stop)


if __name__ == "__main__":
    main()

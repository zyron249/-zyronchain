"""Telegram bot for /start /play /profile /rank /invite /reminders /help and the Play Zyron menu button.

It also runs the reminder DM loop (energy full, daily chest). This process does not change group
permissions, history, admins, or other bots.
"""

from __future__ import annotations

import logging
import signal
import threading
import time
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from zyron_node import reminders, telegram_api
from zyron_node.auth import TelegramIdentity
from zyron_node.buildinfo import CLIENT_BUILD
from zyron_node.config import load_settings, validate_settings
from zyron_node.db import create_pool, migrate
from zyron_node.economy import POINTS_NOTICE
from zyron_node.game import invite_link, leaderboard_view, open_session, referral_code_from_param, remember_pending_referral
from zyron_node.logging_setup import setup_logging

log = logging.getLogger("zyron_node.bot")

MENU_REFRESH_OK_SECONDS = 6 * 60 * 60
MENU_REFRESH_RETRY_SECONDS = 20

COMMANDS = [
    {"command": "start", "description": "Open ZYRON NODE"},
    {"command": "play", "description": "Play in the Mini App"},
    {"command": "profile", "description": "Your node profile"},
    {"command": "rank", "description": "Leaderboard snapshot"},
    {"command": "invite", "description": "Your referral link"},
    {"command": "reminders", "description": "Reminder DMs on or off"},
    {"command": "help", "description": "How the game works"},
]

PRIVATE_COMMANDS = {"start", "play", "profile", "rank", "invite", "help"}


def parse_command(text: str) -> tuple[str, str]:
    parts = (text or "").strip().split(maxsplit=1)
    if not parts or not parts[0].startswith("/"):
        return "", ""
    command = parts[0].split("@", 1)[0][1:].lower()
    argument = parts[1].strip() if len(parts) > 1 else ""
    return command, argument


def versioned_webapp_url(webapp_url: str) -> str:
    """Append the shell build so Telegram refetches Play Zyron instead of a cached page."""
    if not webapp_url.startswith("https://"):
        return webapp_url
    parts = urlsplit(webapp_url)
    pairs = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key != "v"]
    pairs.append(("v", CLIENT_BUILD))
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", urlencode(pairs), parts.fragment))


def play_markup(webapp_url: str) -> dict | None:
    url = versioned_webapp_url(webapp_url)
    if url.startswith("https://"):
        return {"inline_keyboard": [[{"text": "Play Zyron", "web_app": {"url": url}}]]}
    return None


def menu_button_payload(webapp_url: str) -> dict:
    url = versioned_webapp_url(webapp_url)
    if url.startswith("https://"):
        return {"menu_button": {"type": "web_app", "text": "Play Zyron", "web_app": {"url": url}}}
    return {"menu_button": {"type": "commands"}}


def sync_telegram_menu(token: str, webapp_url: str, call=None) -> None:
    """Register commands and the versioned Play Zyron button. Raises if Telegram rejects it."""
    invoke = call or telegram_call
    invoke(token, "setMyCommands", {"commands": COMMANDS})
    invoke(token, "setChatMenuButton", menu_button_payload(webapp_url))


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
            "Commands: /play /profile /rank /invite /reminders /help\n\n"
            "Energy regenerates on server time. In the Mini App, Start node keeps cycling until energy runs out. "
            "Supply chests collect the daily streak, quests, and level rewards. "
            "Upgrades spend Zyron Points. "
            "Linking a wallet stores only a public ZYN address — never a seed or private key. "
            "The bot can DM you when your energy is full; /reminders off stops that.\n\n"
            f"{POINTS_NOTICE}"
        )
    elif command == "profile":
        player = (profile or {}).get("player") or {}
        energy = player.get("energy") or {}
        text = (
            f"{player.get('displayName', 'Operator')} · level {player.get('level', 1)}\n"
            f"Zyron Points: {player.get('points', 0)}\n"
            f"Tier: {(player.get('tier') or {}).get('label') or 'Unranked'}\n"
            f"Energy: {energy.get('current', 0)}/{energy.get('max', 0)}\n"
            f"Network Power: {player.get('networkPower', 0)}\n"
            f"Streak: {((player.get('streak') or {}).get('count', 0))} days"
        )
    elif command == "rank":
        text = "Leaderboards are Daily, Weekly, Season, and All-time inside the Mini App."
        if profile and profile.get("top"):
            lines = []
            for row in profile["top"]:
                tier = (row.get("tier") or {}).get("label")
                label = f"{row['displayName']} · {tier}" if tier else row["displayName"]
                lines.append(f"{row['rank']}. {label} — {row['score']}")
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
    if settings.reminders_enabled:
        threading.Thread(
            target=reminders.reminder_loop,
            args=(pool, token, versioned_webapp_url(settings.miniapp_url), stop, telegram_call),
            name="reminders",
            daemon=True,
        ).start()
        log.info("reminder loop started (every %ss)", reminders.CHECK_SECONDS)
    try:
        offset = None
        next_menu = 0.0
        while not stop.is_set():
            if time.monotonic() >= next_menu:
                try:
                    sync_telegram_menu(token, settings.miniapp_url)
                    log.info("telegram commands and Play Zyron menu button registered")
                    next_menu = time.monotonic() + MENU_REFRESH_OK_SECONDS
                except Exception:  # noqa: BLE001 — keep polling; retry the versioned button
                    log.warning("telegram menu registration failed")
                    next_menu = time.monotonic() + MENU_REFRESH_RETRY_SECONDS
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
                try:
                    handle_update(pool, settings, update)
                except Exception:  # noqa: BLE001 — one bad update must not stop polling
                    log.warning("telegram update handling failed")
    finally:
        pool.close()


def handle_update(pool, settings, update: dict, call=None) -> None:
    invoke = call or telegram_call
    token = settings.telegram_bot_token
    callback = update.get("callback_query")
    if callback:
        handle_callback(pool, settings, callback, invoke)
        return
    message = update.get("message") or {}
    text = message.get("text") or ""
    user = message.get("from") or {}
    chat = message.get("chat") or {}
    if not user.get("id") or not chat.get("id"):
        return
    private = chat.get("type") == "private"
    if not text.startswith("/"):
        if private:
            reminders.record_chat(pool, int(user["id"]), int(chat["id"]))
        return
    command, argument = parse_command(text)
    if command == "reminders":
        reply = reminders_reply(pool, int(user["id"]), argument) if private else {
            "text": "Send /reminders to the bot in a private chat."
        }
    elif command in PRIVATE_COMMANDS:
        reply = handle_private_command(pool, settings, user, command, argument)
    else:
        return
    if private:
        reminders.record_chat(pool, int(user["id"]), int(chat["id"]))
    reply["chat_id"] = chat["id"]
    try:
        invoke(token, "sendMessage", reply)
    except Exception:  # noqa: BLE001
        log.warning("telegram sendMessage failed")


def reminders_reply(pool, telegram_id: int, argument: str) -> dict:
    choice = argument.strip().lower()
    if choice in {"off", "stop", "no"}:
        found = reminders.set_opt_out(pool, telegram_id, True)
        text = "Reminders are off. Send /reminders on to turn them back on." if found else (
            "Open the Mini App once first, then use /reminders."
        )
    elif choice in {"on", "start", "yes"}:
        found = reminders.set_opt_out(pool, telegram_id, False)
        text = (
            "Reminders are on. I'll DM you when your energy is full, and at most once a day about your daily chest."
            if found else "Open the Mini App once first, then use /reminders."
        )
    else:
        enabled = reminders.reminders_status(pool, telegram_id)
        if enabled is None:
            text = "Open the Mini App once first, then use /reminders."
        else:
            state = "on" if enabled else "off"
            text = f"Reminders are {state}. Use /reminders on or /reminders off."
    return {"text": text}


def handle_callback(pool, settings, callback: dict, invoke) -> None:
    token = settings.telegram_bot_token
    user = callback.get("from") or {}
    if callback.get("data") != reminders.CALLBACK_OFF or not user.get("id"):
        try:
            invoke(token, "answerCallbackQuery", {"callback_query_id": callback.get("id")})
        except Exception:  # noqa: BLE001
            pass
        return
    reminders.set_opt_out(pool, int(user["id"]), True)
    notice = "Reminders are off. Send /reminders on to turn them back on."
    try:
        invoke(token, "answerCallbackQuery", {"callback_query_id": callback["id"], "text": notice})
    except Exception:  # noqa: BLE001
        log.warning("telegram answerCallbackQuery failed")
    message = callback.get("message") or {}
    chat = message.get("chat") or {}
    if chat.get("id") and message.get("message_id"):
        markup = play_markup(settings.miniapp_url) or {"inline_keyboard": []}
        try:
            invoke(token, "editMessageReplyMarkup", {
                "chat_id": chat["id"], "message_id": message["message_id"], "reply_markup": markup,
            })
            invoke(token, "sendMessage", {"chat_id": chat["id"], "text": notice})
        except Exception:  # noqa: BLE001
            log.warning("telegram reminder opt-out confirmation failed")


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
    reply = reply_for(command, argument, profile, settings.miniapp_url)
    if command == "invite" and profile:
        reply["text"] = "Invite operators with:\n" + invite_link(
            settings.telegram_bot_username, profile["player"]["referral"]["code"]
        )
    return reply


def telegram_call(token: str, method: str, payload: dict, timeout: float = 15) -> dict:
    return telegram_api.call(token, method, payload, timeout=timeout)


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

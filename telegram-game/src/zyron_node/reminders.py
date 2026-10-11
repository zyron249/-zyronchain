"""Reminder DMs sent by the bot process.

Primary trigger: the moment a player's energy becomes full, computed from the server regen
model (one message per refill cycle). Secondary trigger: the daily chest is ready, at most once
per 24h. Only players who gave the bot a private chat get reminders, every message carries a
"Turn off reminders" button, /reminders off works too, and a 403 marks the chat unreachable.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

from zyron_node.economy import empty_levels, max_energy, regen_interval_seconds
from zyron_node.telegram_api import TelegramError

log = logging.getLogger("zyron_node.reminders")

CHECK_SECONDS = 90
ACTIVE_SKIP_SECONDS = 5 * 60
ENERGY_STALE_SECONDS = 24 * 60 * 60
CHEST_REPEAT_SECONDS = 24 * 60 * 60
CHEST_IDLE_SECONDS = 12 * 60 * 60
CHEST_LAPSED_SECONDS = 7 * 24 * 60 * 60
CHEST_WINDOW_UTC = (12, 20)
STACK_GAP_SECONDS = 60 * 60
SEND_INTERVAL_SECONDS = 0.05  # 20 messages/s, under Telegram's ~30/s bulk limit
MAX_RETRY_AFTER_SECONDS = 60
MAX_SENDS_PER_TICK = 300
CALLBACK_OFF = "reminders:off"
LOCK_KEY = 0x5A59524D  # "ZYRM": one reminder runner at a time across overlapping deploys
JOB_NAME = "reminders"

ENERGY_TEXTS = (
    "\u26a1 Your energy is full. Start your node and keep building blocks.",
    "\u26a1 Energy full. Your node is ready to build blocks again.",
    "\u26a1 Your node has full energy. Tap Play Zyron to start building.",
)
CHEST_TEXTS = (
    "\U0001f381 Your daily chest is ready. Open it to keep your streak going.",
    "\U0001f381 A daily supply chest is waiting in ZYRON NODE.",
)
FOOTER = "Zyron Points are off-chain game points."


@dataclass(frozen=True)
class Decision:
    kind: str | None  # "energy", "chest", or None
    reason: str


def energy_full_at(energy: int, updated_at: datetime, levels: dict[str, int]) -> datetime:
    """When stored energy reaches the cap under apply_energy(). Already full: the time it was last stored."""
    cap = max_energy(levels)
    current = max(0, min(int(energy), cap))
    if current >= cap:
        return updated_at
    return updated_at + timedelta(seconds=(cap - current) * regen_interval_seconds(levels))


def last_active(player: dict) -> datetime:
    seen = player["last_seen_at"]
    cycled = player.get("last_cycle_at")
    return max(seen, cycled) if cycled else seen


def decide(player: dict, levels: dict[str, int], now: datetime) -> Decision:
    if player.get("banned"):
        return Decision(None, "banned")
    if not player.get("chat_id"):
        return Decision(None, "no_chat")
    if player.get("reminders_opt_out"):
        return Decision(None, "opted_out")
    if player.get("reminders_unreachable_at"):
        return Decision(None, "unreachable")
    active = last_active(player)
    if (now - active).total_seconds() < ACTIVE_SKIP_SECONDS:
        return Decision(None, "active")

    full_at = energy_full_at(int(player["energy"]), player["energy_updated_at"], levels)
    if full_at <= now:
        reminded = player.get("energy_reminded_at")
        if full_at <= active:
            reason = "energy_seen"  # they opened the app after it was full
        elif reminded is not None and reminded >= full_at:
            reason = "energy_sent"  # one per refill cycle
        elif (now - full_at).total_seconds() > ENERGY_STALE_SECONDS:
            reason = "energy_stale"
        else:
            return Decision("energy", "energy_full")
    else:
        reason = "energy_regen"

    last_date = player.get("streak_last_date")
    if last_date is not None and last_date >= now.date():
        return Decision(None, reason)
    idle = (now - active).total_seconds()
    if idle < CHEST_IDLE_SECONDS or idle > CHEST_LAPSED_SECONDS:
        return Decision(None, reason)
    if not CHEST_WINDOW_UTC[0] <= now.hour < CHEST_WINDOW_UTC[1]:
        return Decision(None, reason)
    chest_at = player.get("chest_reminded_at")
    if chest_at is not None and (now - chest_at).total_seconds() < CHEST_REPEAT_SECONDS:
        return Decision(None, reason)
    any_at = player.get("last_reminded_at")
    if any_at is not None and (now - any_at).total_seconds() < STACK_GAP_SECONDS:
        return Decision(None, reason)
    return Decision("chest", "chest_ready")


def reminder_message(kind: str, player_id: int, now: datetime, play_url: str) -> dict:
    texts = ENERGY_TEXTS if kind == "energy" else CHEST_TEXTS
    text = texts[(int(player_id) + now.toordinal()) % len(texts)] + "\n\n" + FOOTER
    rows = []
    if play_url.startswith("https://"):
        rows.append([{"text": "Play Zyron", "web_app": {"url": play_url}}])
    rows.append([{"text": "Turn off reminders", "callback_data": CALLBACK_OFF}])
    return {"text": text, "reply_markup": {"inline_keyboard": rows}, "disable_web_page_preview": True}


CANDIDATE_COLUMNS = """
    id, telegram_id, chat_id, banned, reminders_opt_out, reminders_unreachable_at,
    energy, energy_updated_at, last_seen_at, last_cycle_at, streak_last_date,
    energy_reminded_at, chest_reminded_at, last_reminded_at
"""


def load_candidates(conn, *, everyone: bool) -> list[dict]:
    where = "chat_id IS NOT NULL" if everyone else (
        "chat_id IS NOT NULL AND reminders_opt_out = FALSE AND reminders_unreachable_at IS NULL AND banned = FALSE"
    )
    return conn.execute(f"SELECT {CANDIDATE_COLUMNS} FROM players WHERE {where} ORDER BY id").fetchall()


def load_levels_for(conn, player_ids: list[int]) -> dict[int, dict[str, int]]:
    levels = {pid: empty_levels() for pid in player_ids}
    if not player_ids:
        return levels
    rows = conn.execute(
        "SELECT player_id, module, level FROM player_upgrades WHERE player_id = ANY(%s)",
        (player_ids,),
    ).fetchall()
    for row in rows:
        bucket = levels.get(int(row["player_id"]))
        if bucket is not None and row["module"] in bucket:
            bucket[row["module"]] = int(row["level"])
    return levels


def plan(pool, now: datetime, *, everyone: bool = False) -> tuple[list[tuple[dict, Decision]], dict]:
    with pool.connection() as conn:
        players = load_candidates(conn, everyone=everyone)
        levels = load_levels_for(conn, [int(p["id"]) for p in players])
        total = conn.execute("SELECT count(*) AS n FROM players").fetchone()["n"]
    reasons: dict[str, int] = {}
    due: list[tuple[dict, Decision]] = []
    for player in players:
        decision = decide(player, levels[int(player["id"])], now)
        reasons[decision.reason] = reasons.get(decision.reason, 0) + 1
        if decision.kind:
            due.append((player, decision))
    summary = {
        "players": int(total),
        "withChat": len(players) if everyone else None,
        "reasons": reasons,
        "due": {
            "energy": sum(1 for _, d in due if d.kind == "energy"),
            "chest": sum(1 for _, d in due if d.kind == "chest"),
        },
    }
    return due, summary


def claim(conn, player: dict, kind: str, now: datetime) -> bool:
    """Atomically mark the reminder as sent so overlapping runners never double-send."""
    column = "energy_reminded_at" if kind == "energy" else "chest_reminded_at"
    previous = player.get(column)
    row = conn.execute(
        f"""
        UPDATE players SET {column} = %s, last_reminded_at = %s
        WHERE id = %s AND chat_id IS NOT NULL AND reminders_opt_out = FALSE
          AND reminders_unreachable_at IS NULL AND banned = FALSE
          AND {column} IS NOT DISTINCT FROM %s
        RETURNING id
        """,
        (now, now, player["id"], previous),
    ).fetchone()
    return row is not None


def release(conn, player: dict, kind: str) -> None:
    column = "energy_reminded_at" if kind == "energy" else "chest_reminded_at"
    conn.execute(
        f"UPDATE players SET {column} = %s, last_reminded_at = %s WHERE id = %s",
        (player.get(column), player.get("last_reminded_at"), player["id"]),
    )


def mark_unreachable(conn, player_id: int, now: datetime) -> None:
    conn.execute("UPDATE players SET reminders_unreachable_at = %s WHERE id = %s", (now, player_id))


def write_heartbeat(conn, name: str, now: datetime, detail: dict) -> None:
    from psycopg.types.json import Jsonb

    conn.execute(
        """
        INSERT INTO bot_jobs (name, last_run_at, detail) VALUES (%s, %s, %s)
        ON CONFLICT (name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, detail = EXCLUDED.detail
        """,
        (name, now, Jsonb(detail)),
    )


def run_tick(
    pool,
    token: str,
    play_url: str,
    now: datetime,
    call: Callable[[str, str, dict], dict],
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """One scheduler pass. Returns counts; never raises for a single failed chat."""
    sent = {"energy": 0, "chest": 0}
    blocked = failed = 0
    with pool.connection() as lock_conn:
        got = lock_conn.execute("SELECT pg_try_advisory_lock(%s) AS ok", (LOCK_KEY,)).fetchone()["ok"]
        if not got:
            return {"skipped": "locked"}
        try:
            due, summary = plan(pool, now)
            for player, decision in due[:MAX_SENDS_PER_TICK]:
                kind = decision.kind
                with pool.connection() as conn:
                    if not claim(conn, player, kind, now):
                        continue
                payload = reminder_message(kind, int(player["id"]), now, play_url)
                payload["chat_id"] = int(player["chat_id"])
                outcome = _deliver(token, payload, call, sleep)
                with pool.connection() as conn:
                    if outcome == "sent":
                        sent[kind] += 1
                    elif outcome == "blocked":
                        blocked += 1
                        release(conn, player, kind)
                        mark_unreachable(conn, int(player["id"]), now)
                    else:
                        failed += 1
                        release(conn, player, kind)
                if outcome == "throttled":
                    break  # Telegram asked us to slow down twice; resume next tick
                sleep(SEND_INTERVAL_SECONDS)
            detail = {"sent": sent, "blocked": blocked, "failed": failed, "due": summary["due"]}
            with pool.connection() as conn:
                write_heartbeat(conn, JOB_NAME, now, detail)
            return detail
        finally:
            lock_conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))


def _deliver(token: str, payload: dict, call, sleep) -> str:
    for attempt in range(2):
        try:
            call(token, "sendMessage", payload)
            return "sent"
        except TelegramError as exc:
            if exc.unreachable:
                return "blocked"
            if exc.status == 429 and attempt == 0:
                sleep(min(MAX_RETRY_AFTER_SECONDS, max(1, exc.retry_after or 1)))
                continue
            return "throttled" if exc.status == 429 else "failed"
        except Exception:  # noqa: BLE001 — network trouble: retry next tick
            return "failed"
    return "throttled"


def preview(pool, now: datetime) -> dict:
    """Admin dry run: who would get a reminder right now. Sends nothing."""
    _, summary = plan(pool, now, everyone=True)
    with pool.connection() as conn:
        job = conn.execute("SELECT last_run_at, detail FROM bot_jobs WHERE name = %s", (JOB_NAME,)).fetchone()
        flags = conn.execute(
            """
            SELECT count(*) FILTER (WHERE reminders_opt_out) AS opted_out,
                   count(*) FILTER (WHERE reminders_unreachable_at IS NOT NULL) AS unreachable
            FROM players
            """
        ).fetchone()
    summary.update(
        {
            "dryRun": True,
            "optedOut": int(flags["opted_out"]),
            "unreachable": int(flags["unreachable"]),
            "scheduler": {
                "lastRunAt": job["last_run_at"].isoformat() if job else None,
                "last": job["detail"] if job else None,
                "checkSeconds": CHECK_SECONDS,
            },
            "serverTime": now.isoformat(),
        }
    )
    return summary


def record_chat(pool, telegram_id: int, chat_id: int) -> None:
    """The player wrote to the bot in private: remember the chat and clear a stale 403."""
    with pool.connection() as conn:
        conn.execute(
            "UPDATE players SET chat_id = %s, reminders_unreachable_at = NULL WHERE telegram_id = %s",
            (chat_id, telegram_id),
        )


def set_opt_out(pool, telegram_id: int, opted_out: bool) -> bool:
    with pool.connection() as conn:
        row = conn.execute(
            "UPDATE players SET reminders_opt_out = %s WHERE telegram_id = %s RETURNING id",
            (opted_out, telegram_id),
        ).fetchone()
    return row is not None


def reminders_status(pool, telegram_id: int) -> bool | None:
    with pool.connection() as conn:
        row = conn.execute("SELECT reminders_opt_out FROM players WHERE telegram_id = %s", (telegram_id,)).fetchone()
    return None if row is None else not row["reminders_opt_out"]


def send_owner_test(pool, token: str, community_chat: str, play_url: str, now: datetime, call) -> dict:
    """Send one clearly marked test reminder to the community group's creator, and nobody else."""
    try:
        admins = call(token, "getChatAdministrators", {"chat_id": community_chat}).get("result") or []
    except TelegramError as exc:
        return {"sent": False, "reason": f"admins_unavailable_{exc.status}"}
    creator = next((a.get("user") or {} for a in admins if a.get("status") == "creator"), {})
    if not creator.get("id"):
        return {"sent": False, "reason": "creator_hidden"}
    with pool.connection() as conn:
        player = conn.execute(
            "SELECT id, chat_id, reminders_opt_out FROM players WHERE telegram_id = %s",
            (int(creator["id"]),),
        ).fetchone()
    if not player or not player["chat_id"]:
        return {"sent": False, "reason": "owner_has_no_private_chat"}
    if player["reminders_opt_out"]:
        return {"sent": False, "reason": "owner_opted_out"}
    payload = reminder_message("energy", int(player["id"]), now, play_url)
    payload["text"] = "Test reminder (sent once by the admin check).\n\n" + payload["text"]
    payload["chat_id"] = int(player["chat_id"])
    try:
        call(token, "sendMessage", payload)
    except TelegramError as exc:
        return {"sent": False, "reason": f"send_failed_{exc.status}"}
    return {"sent": True, "reason": "sent_to_owner"}


def reminder_loop(pool, token: str, play_url: str, stop: threading.Event, call, interval: float = CHECK_SECONDS) -> None:
    if stop.wait(10):
        return
    while not stop.is_set():
        try:
            result = run_tick(pool, token, play_url, datetime.now(timezone.utc), call)
            sent = result.get("sent") or {}
            if sent.get("energy") or sent.get("chest") or result.get("blocked"):
                log.info("reminders sent energy=%s chest=%s blocked=%s", sent.get("energy"), sent.get("chest"), result.get("blocked"))
        except Exception:  # noqa: BLE001 — keep the loop alive; next tick retries
            log.warning("reminder tick failed", exc_info=True)
        stop.wait(interval)

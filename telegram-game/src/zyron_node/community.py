"""ZYRONCHAIN group features run by the bot: daily/weekly builder boards, the weekly invite
contest, the weekly quiz, short-lived welcome notes, and the public /stats /wallet /roadmap text.

Everything here is honest and off-chain: Zyron Points are game points, the network is a testnet,
and nothing mentions prices. The bot only deletes its own welcome notes and only stops its own
quiz polls; it never changes group settings, members, admins, or other people's messages.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Callable

from psycopg.types.json import Jsonb

from zyron_node.economy import ABUSE_REFERRAL_BLOCK, POINTS_NOTICE
from zyron_node.telegram_api import TelegramError

log = logging.getLogger("zyron_node.community")

LOOP_SECONDS = 15
LOCK_KEY = 0x5A59434D  # "ZYCM"
DAILY_POST_HOUR_UTC = 12
WEEKLY_POST_WEEKDAY = 6  # Sunday
QUIZ_WEEKDAY = 2  # Wednesday
QUIZ_HOUR_UTC = 16
QUIZ_OPEN_SECONDS = 6 * 24 * 60 * 60
QUIZ_CATCH_UP_SECONDS = 24 * 60 * 60
QUIZ_POINTS_PER_CORRECT = 20
QUIZ_MAX_POINTS = 60  # cap per weekly quiz (3 questions)
BOARD_SIZE = 10
INVITE_BOARD_SIZE = 5
WELCOME_DELETE_SECONDS = 120
WELCOME_COOLDOWN_SECONDS = 90
WELCOME_DAILY_CAP = 40
WELCOME_MAX_NAMES = 5
COMMAND_COOLDOWN_SECONDS = 30
STATS_CACHE_SECONDS = 60
WALLET_URL = "https://zyronchain.com/app/"
CHECKLIST_URL = "https://github.com/zyron249/-zyronchain/blob/main/docs/PUBLIC_LAUNCH_CHECKLIST.md"
NETWORK_STATUS = (
    "Network: ZyronChain public testnet is authorized but not activated yet. "
    "Today you can run the local devnet (cd l1 && npm run devnet) or try the phone wallet (testnet)."
)


@dataclass(frozen=True)
class Question:
    id: str
    text: str
    options: tuple[str, ...]
    correct: int
    explanation: str


# Facts only from the repo: WHITEPAPER.md (50,000,000 ZYN cap), README.md (>2/3 finality, not EVM),
# website/index.html (open-source, local keys, fixed 50M cap, testnet authorized not activated),
# website/app (phone wallet: testnet only, keys generated and encrypted on the device).
QUESTIONS: tuple[Question, ...] = (
    Question("supply", "What is ZyronChain's fixed maximum ZYN supply?",
             ("21 million", "50 million", "1 billion", "Unlimited"), 1,
             "The ZYN supply is capped at 50,000,000 (see WHITEPAPER.md)."),
    Question("keys", "Where are ZyronChain phone wallet keys generated and kept?",
             ("On ZyronChain servers", "On your own device", "Inside this Telegram group", "With the bot"), 1,
             "Local keys: the wallet generates and encrypts keys on your device."),
    Question("testnet", "Which network is the ZyronChain phone wallet for today?",
             ("Mainnet", "Testnet only", "Any EVM chain", "No network"), 1,
             "The phone wallet is testnet only and unaudited."),
    Question("opensource", "Can anyone read ZyronChain's source code?",
             ("Yes, it is open source on GitHub", "No, it is closed source", "Only validators", "Only after mainnet"), 0,
             "ZyronChain is open source: github.com/zyron249/-zyronchain"),
    Question("block", "What does a block in a blockchain hold?",
             ("A batch of transactions", "A user's password", "A chat message", "Nothing at all"), 0,
             "A block bundles transactions and links to the block before it."),
    Question("hash", "What links each block to the block before it?",
             ("The previous block's hash", "The block's color", "The sender's username", "A random number"), 0,
             "Each block commits to the previous block's hash, so history can't be silently changed."),
    Question("seed", "Who should ever see your seed phrase or private key?",
             ("Only you", "Group admins", "Support staff", "Anyone who asks"), 0,
             "Only you. Nobody from ZyronChain will ever ask for it."),
    Question("points", "Are Zyron Points in ZYRON NODE the same as ZYN?",
             ("No, they are off-chain game points", "Yes, 1 point = 1 ZYN", "Yes, after the season", "Only for top players"), 0,
             "Zyron Points are off-chain game points, not ZYN."),
    Question("finality", "How many validator votes does ZyronChain need to finalize a block?",
             ("Exactly one", "Half", "More than two thirds", "None"), 2,
             "ZyronChain finalizes blocks with more than 2/3 of validators (README.md)."),
    Question("evm", "Can MetaMask connect to ZyronChain?",
             ("Yes, it's an EVM chain", "No, ZyronChain is not EVM", "Only on mainnet", "Only on Sundays"), 1,
             "ZyronChain is not EVM, so MetaMask can't connect (README.md)."),
    Question("final", "What does it mean when a block is final?",
             ("It can no longer be reverted", "It is the last block ever", "It has no transactions", "It is waiting for votes"), 0,
             "A final block is settled and can't be reverted."),
    Question("testnet_meaning", "What is a testnet for?",
             ("Testing software with test coins", "Real payments", "Storing passwords", "Chatting"), 0,
             "A testnet lets people try the software with test coins that aren't real funds."),
)


# ---------------------------------------------------------------------------- helpers

def is_community_chat(chat: dict, community_chat: str) -> bool:
    if not chat:
        return False
    if community_chat.startswith("@"):
        return str(chat.get("username") or "").lower() == community_chat[1:].lower()
    return str(chat.get("id")) == community_chat


def clean_name(value: str | None, fallback: str = "Operator") -> str:
    text = " ".join("".join(ch for ch in str(value or "") if ch.isprintable()).split())
    return (text[:32] or fallback)


def day_bounds(day: date) -> tuple[datetime, datetime]:
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    return start, start + timedelta(days=1)


def play_link(bot_username: str) -> str | None:
    return f"https://t.me/{bot_username}?start=play" if bot_username else None


def link_markup(bot_username: str, wallet: bool = False) -> dict | None:
    row = []
    link = play_link(bot_username)
    if link:
        row.append({"text": "Play ZYRON NODE", "url": link})
    if wallet:
        row.append({"text": "Phone wallet (testnet)", "url": WALLET_URL})
    return {"inline_keyboard": [row]} if row else None


# ---------------------------------------------------------------------------- boards

def top_builders(conn, start: datetime, end: datetime, limit: int = BOARD_SIZE) -> list[dict]:
    """Blocks built = completed node cycles in the window. Banned players are left out."""
    return conn.execute(
        """
        SELECT p.id, p.display_name, COUNT(*)::int AS blocks
        FROM point_ledger l JOIN players p ON p.id = l.player_id
        WHERE l.reason = 'cycle' AND l.amount > 0 AND l.created_at >= %s AND l.created_at < %s
          AND p.banned = FALSE
        GROUP BY p.id, p.display_name
        ORDER BY blocks DESC, p.id ASC
        LIMIT %s
        """,
        (start, end, limit),
    ).fetchall()


def top_inviters(conn, start: datetime, end: datetime, limit: int = INVITE_BOARD_SIZE) -> list[dict]:
    """Only referrals the existing anti-abuse checks rewarded (min cycles, age, bans, abuse score, weekly cap)."""
    return conn.execute(
        """
        SELECT p.id, p.display_name, COUNT(*)::int AS invites
        FROM referrals r
        JOIN players p ON p.id = r.referrer_id
        JOIN players q ON q.id = r.referee_id
        WHERE r.status = 'rewarded' AND r.rewarded_at >= %s AND r.rewarded_at < %s
          AND p.banned = FALSE AND q.banned = FALSE
          AND p.abuse_score < %s AND q.abuse_score < %s
        GROUP BY p.id, p.display_name
        ORDER BY invites DESC, p.id ASC
        LIMIT %s
        """,
        (start, end, ABUSE_REFERRAL_BLOCK, ABUSE_REFERRAL_BLOCK, limit),
    ).fetchall()


def _lines(rows: list[dict], key: str, unit: str) -> list[str]:
    medals = {1: "\U0001f947", 2: "\U0001f948", 3: "\U0001f949"}
    out = []
    for rank, row in enumerate(rows, start=1):
        count = int(row[key])
        label = unit if count == 1 else unit + "s"
        out.append(f"{medals.get(rank, f'{rank}.')} {clean_name(row['display_name'])} — {count:,} {label}")
    return out


def fmt_day(day: date) -> str:
    return f"{day:%a} {day:%b} {day.day}"


def leaderboard_post(pool, now: datetime) -> tuple[str, dict] | None:
    """Text for the noon post: yesterday's builders, plus the weekly summary and invite contest on Sunday."""
    yesterday = now.date() - timedelta(days=1)
    with pool.connection() as conn:
        daily = top_builders(conn, *day_bounds(yesterday))
        weekly = invites = []
        weekly_start = now.date() - timedelta(days=7)
        if now.weekday() == WEEKLY_POST_WEEKDAY:
            start, _ = day_bounds(weekly_start)
            end, _ = day_bounds(now.date())
            weekly = top_builders(conn, start, end)
            invites = top_inviters(conn, start, end)
    if not daily and not weekly and not invites:
        return None
    parts = []
    if daily:
        parts.append(f"\U0001f9f1 Top block builders · {fmt_day(yesterday)} (UTC)\n" + "\n".join(_lines(daily, "blocks", "block")))
    if weekly:
        span = f"{weekly_start:%b} {weekly_start.day} – {yesterday:%b} {yesterday.day}"
        parts.append(f"\U0001f4c5 Weekly summary · {span} (UTC)\n" + "\n".join(_lines(weekly, "blocks", "block")))
    if invites:
        parts.append(
            "\U0001f91d Weekly invite contest (qualified invites only)\n" + "\n".join(_lines(invites, "invites", "invite"))
        )
    parts.append("Blocks are completed node cycles in ZYRON NODE. " + POINTS_NOTICE)
    detail = {"daily": len(daily), "weekly": len(weekly), "invites": len(invites)}
    return "\n\n".join(parts), detail


# ---------------------------------------------------------------------------- post bookkeeping

def claim_post(conn, kind: str, period_key: str, now: datetime) -> bool:
    row = conn.execute(
        """
        INSERT INTO community_posts (kind, period_key, status, created_at) VALUES (%s, %s, 'claimed', %s)
        ON CONFLICT (kind, period_key) DO NOTHING RETURNING kind
        """,
        (kind, period_key, now),
    ).fetchone()
    return row is not None


def finish_post(conn, kind: str, period_key: str, status: str, message_id: int | None, detail: dict) -> None:
    conn.execute(
        "UPDATE community_posts SET status = %s, message_id = %s, detail = %s WHERE kind = %s AND period_key = %s",
        (status, message_id, Jsonb(detail), kind, period_key),
    )


def post_leaderboard(pool, settings, now: datetime, call, *, force: bool = False) -> dict:
    """Post the board for this UTC day once. Skips (and records the skip) when there is no data."""
    period = now.date().isoformat()
    if not force and now.hour < DAILY_POST_HOUR_UTC:
        return {"posted": False, "reason": "not_yet"}
    with pool.connection() as conn:
        if not claim_post(conn, "leaderboard", period, now):
            return {"posted": False, "reason": "already_done", "period": period}
    built = leaderboard_post(pool, now)
    if built is None:
        with pool.connection() as conn:
            finish_post(conn, "leaderboard", period, "skipped", None, {"reason": "no_data"})
        return {"posted": False, "reason": "no_data", "period": period}
    text, detail = built
    payload = {"chat_id": settings.community_chat, "text": text, "disable_web_page_preview": True}
    markup = link_markup(settings.telegram_bot_username)
    if markup:
        payload["reply_markup"] = markup
    try:
        body = call(settings.telegram_bot_token, "sendMessage", payload)
    except Exception as exc:  # noqa: BLE001
        with pool.connection() as conn:
            finish_post(conn, "leaderboard", period, "failed", None, {"error": _err(exc)})
        return {"posted": False, "reason": "send_failed", "error": _err(exc), "period": period}
    message_id = int((body.get("result") or {}).get("message_id") or 0) or None
    with pool.connection() as conn:
        finish_post(conn, "leaderboard", period, "posted", message_id, detail)
    return {"posted": True, "period": period, "messageId": message_id, **detail}


def _err(exc: Exception) -> str:
    if isinstance(exc, TelegramError):
        return f"{exc.status} {exc.description[:120]}".strip()
    return type(exc).__name__


# ---------------------------------------------------------------------------- quiz

def quiz_key(now: datetime) -> str:
    year, week, _ = now.isocalendar()
    return f"{year}-W{week:02d}"


def quiz_questions(key: str) -> list[Question]:
    year, week = key.split("-W")
    start = (int(year) * 53 + int(week)) * 3
    return [QUESTIONS[(start + i) % len(QUESTIONS)] for i in range(3)]


def quiz_due(now: datetime) -> bool:
    scheduled = datetime.combine(now.date() - timedelta(days=(now.weekday() - QUIZ_WEEKDAY) % 7),
                                 datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=QUIZ_HOUR_UTC)
    elapsed = (now - scheduled).total_seconds()
    return 0 <= elapsed < QUIZ_CATCH_UP_SECONDS


def post_quiz(pool, settings, now: datetime, call, *, force: bool = False) -> dict:
    key = quiz_key(now)
    if not force and not quiz_due(now):
        return {"posted": False, "reason": "not_due"}
    with pool.connection() as conn:
        if not claim_post(conn, "quiz", key, now):
            return {"posted": False, "reason": "already_done", "quiz": key}
    token = settings.telegram_bot_token
    chat = settings.community_chat
    intro = (
        "\U0001f9e0 Weekly ZyronChain quiz: 3 questions.\n"
        f"Each correct answer earns {QUIZ_POINTS_PER_CORRECT} Zyron Points in ZYRON NODE "
        f"(max {QUIZ_MAX_POINTS} per quiz). One answer per question. Open the game once so points can be credited.\n"
        + POINTS_NOTICE
    )
    polls = []
    try:
        payload = {"chat_id": chat, "text": intro, "disable_web_page_preview": True}
        markup = link_markup(settings.telegram_bot_username)
        if markup:
            payload["reply_markup"] = markup
        call(token, "sendMessage", payload)
        closes = now + timedelta(seconds=QUIZ_OPEN_SECONDS)
        for q in quiz_questions(key):
            body = call(token, "sendPoll", {
                "chat_id": chat,
                "question": q.text,
                "options": [{"text": o} for o in q.options],
                "type": "quiz",
                "is_anonymous": False,
                "correct_option_id": q.correct,
                "explanation": q.explanation,
            })
            message = body.get("result") or {}
            poll = message.get("poll") or {}
            with pool.connection() as conn:
                conn.execute(
                    """
                    INSERT INTO quiz_polls (poll_id, quiz_key, question_id, correct_option, chat_id, message_id, opens_at, closes_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (str(poll["id"]), key, q.id, q.correct, str(message["chat"]["id"]), int(message["message_id"]), now, closes),
                )
            polls.append(q.id)
            time.sleep(0.3)
    except Exception as exc:  # noqa: BLE001
        with pool.connection() as conn:
            finish_post(conn, "quiz", key, "failed", None, {"error": _err(exc), "polls": polls})
        return {"posted": False, "reason": "send_failed", "error": _err(exc), "quiz": key, "polls": polls}
    with pool.connection() as conn:
        finish_post(conn, "quiz", key, "posted", None, {"polls": polls})
    return {"posted": True, "quiz": key, "polls": polls}


def record_quiz_answer(pool, answer: dict, now: datetime) -> dict:
    """Server-side scoring for a native quiz poll answer. First answer only, capped per quiz."""
    from zyron_node.game import active_season, apply_points

    user = answer.get("user") or {}
    options = answer.get("option_ids") or []
    poll_id = str(answer.get("poll_id") or "")
    if not user.get("id") or user.get("is_bot") or not options or not poll_id:
        return {"recorded": False, "reason": "ignored"}
    telegram_id = int(user["id"])
    choice = int(options[0])
    with pool.connection() as conn:
        with conn.transaction():
            poll = conn.execute("SELECT * FROM quiz_polls WHERE poll_id = %s", (poll_id,)).fetchone()
            if poll is None:
                return {"recorded": False, "reason": "unknown_poll"}
            if now >= poll["closes_at"] or poll["stopped"]:
                return {"recorded": False, "reason": "closed"}
            correct = choice == int(poll["correct_option"])
            inserted = conn.execute(
                """
                INSERT INTO quiz_answers (poll_id, telegram_id, option_index, correct, answered_at)
                VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING RETURNING poll_id
                """,
                (poll_id, telegram_id, choice, correct, now),
            ).fetchone()
            if inserted is None:
                return {"recorded": False, "reason": "already_answered"}
            if not correct:
                return {"recorded": True, "correct": False, "points": 0}
            player = conn.execute(
                "SELECT id, banned FROM players WHERE telegram_id = %s FOR UPDATE", (telegram_id,)
            ).fetchone()
            if player is None or player["banned"]:
                return {"recorded": True, "correct": True, "points": 0, "reason": "not_a_player"}
            earned = conn.execute(
                """
                SELECT COALESCE(SUM(a.points), 0)::int AS n FROM quiz_answers a
                JOIN quiz_polls p ON p.poll_id = a.poll_id
                WHERE p.quiz_key = %s AND a.telegram_id = %s
                """,
                (poll["quiz_key"], telegram_id),
            ).fetchone()["n"]
            points = max(0, min(QUIZ_POINTS_PER_CORRECT, QUIZ_MAX_POINTS - int(earned)))
            if points <= 0:
                return {"recorded": True, "correct": True, "points": 0, "reason": "capped"}
            season = active_season(conn)
            apply_points(conn, int(player["id"]), points, "quiz", f"quiz:{poll_id}:{telegram_id}",
                         season["id"] if season else None, now)
            conn.execute(
                "UPDATE quiz_answers SET points = %s WHERE poll_id = %s AND telegram_id = %s",
                (points, poll_id, telegram_id),
            )
            return {"recorded": True, "correct": True, "points": points}


def stop_expired_quizzes(pool, token: str, now: datetime, call) -> int:
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT poll_id, chat_id, message_id FROM quiz_polls WHERE stopped = FALSE AND closes_at <= %s LIMIT 20",
            (now,),
        ).fetchall()
    stopped = 0
    for row in rows:
        try:
            call(token, "stopPoll", {"chat_id": row["chat_id"], "message_id": int(row["message_id"])})
        except TelegramError as exc:
            if exc.status not in (400, 403):
                continue  # transient: try again next loop
        except Exception:  # noqa: BLE001
            continue
        with pool.connection() as conn:
            conn.execute("UPDATE quiz_polls SET stopped = TRUE WHERE poll_id = %s", (row["poll_id"],))
        stopped += 1
    return stopped


# ---------------------------------------------------------------------------- welcome

def welcome_text(names: list[str]) -> str:
    shown = [clean_name(n, "there") for n in names[:WELCOME_MAX_NAMES]]
    extra = len(names) - len(shown)
    who = ", ".join(shown) + (f" and {extra} more" if extra > 0 else "")
    return (
        f"\U0001f44b Welcome to ZYRONCHAIN, {who}!\n"
        "• ZYRON NODE: our Telegram game. Build blocks and earn off-chain Zyron Points.\n"
        "• Phone wallet (testnet): keys stay on your device.\n"
        "This note disappears in 2 minutes."
    )


def welcome(pool, settings, message: dict, now: datetime, call) -> dict:
    members = [m for m in (message.get("new_chat_members") or []) if not m.get("is_bot")]
    if not members:
        return {"sent": False, "reason": "no_humans"}
    with pool.connection() as conn:
        recent = conn.execute(
            """
            SELECT max(created_at) AS last_at,
                   count(*) FILTER (WHERE created_at >= %s) AS today
            FROM community_posts WHERE kind = 'welcome'
            """,
            (now - timedelta(days=1),),
        ).fetchone()
        if recent["last_at"] and (now - recent["last_at"]).total_seconds() < WELCOME_COOLDOWN_SECONDS:
            return {"sent": False, "reason": "cooldown"}
        if int(recent["today"]) >= WELCOME_DAILY_CAP:
            return {"sent": False, "reason": "daily_cap"}
        if not claim_post(conn, "welcome", now.strftime("%Y-%m-%dT%H:%M:%S.%f"), now):
            return {"sent": False, "reason": "cooldown"}
    chat_id = (message.get("chat") or {}).get("id")
    payload = {"chat_id": chat_id, "text": welcome_text([m.get("first_name") or "" for m in members]),
               "disable_web_page_preview": True, "disable_notification": True}
    markup = link_markup(settings.telegram_bot_username, wallet=True)
    if markup:
        payload["reply_markup"] = markup
    try:
        body = call(settings.telegram_bot_token, "sendMessage", payload)
    except Exception as exc:  # noqa: BLE001
        return {"sent": False, "reason": "send_failed", "error": _err(exc)}
    message_id = int((body.get("result") or {}).get("message_id") or 0)
    if message_id:
        with pool.connection() as conn:
            conn.execute(
                "INSERT INTO pending_deletes (chat_id, message_id, delete_at) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                (str(chat_id), message_id, now + timedelta(seconds=WELCOME_DELETE_SECONDS)),
            )
    return {"sent": True, "messageId": message_id}


def delete_due_welcomes(pool, token: str, now: datetime, call) -> int:
    """Remove the bot's own welcome notes after two minutes. Nothing else is ever queued here."""
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT chat_id, message_id FROM pending_deletes WHERE delete_at <= %s ORDER BY delete_at LIMIT 20",
            (now,),
        ).fetchall()
    done = 0
    for row in rows:
        try:
            call(token, "deleteMessage", {"chat_id": row["chat_id"], "message_id": int(row["message_id"])})
        except TelegramError as exc:
            if exc.status not in (400, 403):
                continue  # transient: retry next loop; 400 means it's already gone
        except Exception:  # noqa: BLE001
            continue
        with pool.connection() as conn:
            conn.execute(
                "DELETE FROM pending_deletes WHERE chat_id = %s AND message_id = %s",
                (row["chat_id"], row["message_id"]),
            )
        done += 1
    return done


# ---------------------------------------------------------------------------- commands

_stats_cache: dict[str, tuple[float, str]] = {}
_command_seen: dict[tuple[int, str], float] = {}


def command_allowed(chat_id: int, command: str, private: bool, clock=time.monotonic) -> bool:
    """Group commands are rate-limited per chat so a burst of /stats can't flood the group."""
    if private:
        return True
    key = (int(chat_id), command)
    t = clock()
    last = _command_seen.get(key)
    if last is not None and t - last < COMMAND_COOLDOWN_SECONDS:
        return False
    _command_seen[key] = t
    if len(_command_seen) > 2000:
        _command_seen.clear()
    return True


def stats_text(pool, now: datetime) -> str:
    cached = _stats_cache.get("stats")
    if cached and time.monotonic() - cached[0] < STATS_CACHE_SECONDS:
        return cached[1]
    start, end = day_bounds(now.date())
    with pool.connection() as conn:
        row = conn.execute(
            """
            SELECT count(*)::int AS players,
                   count(*) FILTER (WHERE last_seen_at >= %s OR last_cycle_at >= %s)::int AS active_today,
                   COALESCE(sum(cycle_count), 0)::bigint AS blocks
            FROM players WHERE banned = FALSE
            """,
            (start, start),
        ).fetchone()
        today = conn.execute(
            "SELECT count(*)::int AS n FROM point_ledger WHERE reason = 'cycle' AND created_at >= %s AND created_at < %s",
            (start, end),
        ).fetchone()["n"]
        invites = conn.execute("SELECT count(*)::int AS n FROM referrals WHERE status = 'rewarded'").fetchone()["n"]
    text = (
        "\U0001f4ca ZYRON NODE stats\n"
        f"Players: {int(row['players']):,} · active today: {int(row['active_today']):,}\n"
        f"Blocks built today: {int(today):,} · all time: {int(row['blocks']):,}\n"
        f"Qualified invites: {int(invites):,}\n\n"
        f"{NETWORK_STATUS}\n\n{POINTS_NOTICE}"
    )
    _stats_cache["stats"] = (time.monotonic(), text)
    return text


WALLET_TEXT = (
    "\U0001f4f1 ZyronChain Phone Wallet — testnet only, unaudited.\n"
    "Keys are generated and encrypted on your device; nobody else holds them. "
    "Never share your seed phrase. Test coins are not real funds.\n"
    f"{WALLET_URL}"
)

ROADMAP_TEXT = (
    "\U0001f5fa ZyronChain roadmap (from the public launch checklist; no dates promised)\n\n"
    "Now\n"
    "• Local two-validator devnet anyone can run: cd l1 && npm run devnet\n"
    "• Phone wallet (testnet, unaudited) and the ZYRON NODE game\n\n"
    "Next, before the public testnet is activated\n"
    "• Independent operators running from release artifacts\n"
    "• Independent security audit and retest\n"
    "• Public bootstrap and archive nodes across failure domains\n"
    "• A sustained internet adversarial soak\n\n"
    "Later, before mainnet\n"
    "• A fixed chain ID and genesis, frozen network policy, multi-region recovery drills\n\n"
    "The public testnet is authorized by governance but not activated yet.\n"
    f"{CHECKLIST_URL}"
)


def wallet_reply() -> dict:
    return {"text": WALLET_TEXT, "disable_web_page_preview": True,
            "reply_markup": {"inline_keyboard": [[{"text": "Open wallet (testnet)", "url": WALLET_URL}]]}}


def roadmap_reply() -> dict:
    return {"text": ROADMAP_TEXT, "disable_web_page_preview": True}


# ---------------------------------------------------------------------------- rights check

def rights_report(token: str, community_chat: str, call) -> dict:
    """What the bot can do in the group, and what is missing for these features."""
    report: dict = {"chat": community_chat, "missing": []}
    try:
        me = call(token, "getMe", {}).get("result") or {}
        report["bot"] = {"username": me.get("username"), "readsAllGroupMessages": me.get("can_read_all_group_messages")}
        chat = call(token, "getChat", {"chat_id": community_chat}).get("result") or {}
        report["group"] = {
            "id": chat.get("id"),
            "type": chat.get("type"),
            "title": chat.get("title"),
            "description": chat.get("description"),
        }
        perms = chat.get("permissions") or {}
        member = call(token, "getChatMember", {"chat_id": community_chat, "user_id": me.get("id")}).get("result") or {}
    except TelegramError as exc:
        report["error"] = _err(exc)
        report["missing"].append("bot_cannot_see_group")
        return report
    status = member.get("status")
    is_admin = status in ("administrator", "creator")
    report["member"] = {
        "status": status,
        "admin": is_admin,
        "canDeleteMessages": member.get("can_delete_messages"),
        "canPinMessages": member.get("can_pin_messages"),
        "canManageChat": member.get("can_manage_chat"),
        "canChangeInfo": member.get("can_change_info"),
    }

    def allowed(flag: str) -> bool:
        if is_admin:
            return True
        if status == "restricted":
            return bool(member.get(flag))
        return bool(perms.get(flag, True))

    if status in ("left", "kicked", None):
        report["missing"].append("bot_not_in_group")
    else:
        if not allowed("can_send_messages"):
            report["missing"].append("send_messages")
        if not allowed("can_send_polls"):
            report["missing"].append("send_polls")
        if not allowed("can_add_web_page_previews") and not allowed("can_send_other_messages"):
            report["missing"].append("inline_buttons_may_be_limited")
    # Deleting its own welcome notes and stopping its own polls needs no admin rights.
    report["adminRequired"] = False
    report["ok"] = not report["missing"]
    return report


# ---------------------------------------------------------------------------- loop

def community_tick(pool, settings, now: datetime, call) -> dict:
    token = settings.telegram_bot_token
    result = {"deleted": delete_due_welcomes(pool, token, now, call)}
    with pool.connection() as lock_conn:
        if not lock_conn.execute("SELECT pg_try_advisory_lock(%s) AS ok", (LOCK_KEY,)).fetchone()["ok"]:
            return result
        try:
            if settings.community_posts_enabled:
                result["leaderboard"] = post_leaderboard(pool, settings, now, call)
                result["quiz"] = post_quiz(pool, settings, now, call)
            result["stoppedPolls"] = stop_expired_quizzes(pool, token, now, call)
        finally:
            lock_conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))
    return result


def community_loop(pool, settings, stop: threading.Event, call: Callable, interval: float = LOOP_SECONDS) -> None:
    if stop.wait(5):
        return
    while not stop.is_set():
        try:
            result = community_tick(pool, settings, datetime.now(timezone.utc), call)
            for key in ("leaderboard", "quiz"):
                if (result.get(key) or {}).get("posted"):
                    log.info("community %s posted", key)
        except Exception:  # noqa: BLE001 — keep the loop alive
            log.warning("community tick failed", exc_info=True)
        stop.wait(interval)

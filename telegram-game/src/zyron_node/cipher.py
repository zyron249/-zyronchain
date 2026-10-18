"""Daily cipher. The server knows the word. The client only receives a mask."""

from __future__ import annotations

import hashlib
from datetime import date, datetime

WORDS = ("ORBIT", "CHROME", "WOLF", "BUILDER", "NODE", "ENERGY", "STREAK", "SQUAD", "BLOCK", "GALAXY")
REWARD = 8
MAX_GUESSES = 8


def word_for(day: date) -> str:
    digest = hashlib.sha256(f"zyron-cipher-v1:{day.isoformat()}".encode()).digest()
    return WORDS[digest[0] % len(WORDS)]


def mask_for(day: date) -> str:
    word = word_for(day)
    shown = {0, len(word) - 1, len(word) // 2}
    return " ".join(ch if index in shown else "_" for index, ch in enumerate(word))


def hint_text(day: date) -> str:
    return (
        "ZYRON NODE cipher: " + mask_for(day) + ".\n"
        "Guess the builder word in the game. Zyron Points only, not ZYN."
    )


def cipher_view(conn, player_id: int, now: datetime) -> dict:
    day = now.date()
    rows = conn.execute(
        "SELECT guess, correct, points FROM cipher_guesses WHERE player_id = %s AND day = %s",
        (player_id, day),
    ).fetchall()
    solved = any(row["correct"] for row in rows)
    return {
        "mask": mask_for(day),
        "length": len(word_for(day)),
        "solved": solved,
        "attempts": len(rows),
        "attemptsMax": MAX_GUESSES,
        "reward": REWARD,
        "notice": "One cipher per UTC day. The server checks the word.",
        "serverTime": now.isoformat(),
    }


def answer(pool, player_id: int, guess: str, key: str, now: datetime) -> dict:
    from zyron_node.game import (
        GameError,
        apply_points,
        lock_player,
        reject_if_banned,
        reload_player,
        replay_of,
        require_key,
        store_idempotency,
    )

    require_key(key)
    cleaned = "".join((guess or "").split()).upper()
    if not cleaned.isalpha() or not 3 <= len(cleaned) <= 12:
        raise GameError("bad_guess", "Use 3 to 12 letters.", 400)
    day = now.date()
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "cipher", key)
            if replay:
                return replay
            reject_if_banned(player)
            existing = conn.execute(
                "SELECT correct, points FROM cipher_guesses WHERE player_id = %s AND day = %s",
                (player_id, day),
            ).fetchall()
            if any(row["correct"] for row in existing):
                response = _payload(conn, player, day, False, 0, True, now)
                store_idempotency(conn, player_id, "cipher", key, response, now)
                return response
            if len(existing) >= MAX_GUESSES:
                raise GameError("cipher_limited", "No guesses left today.", 429)
            correct = cleaned == word_for(day)
            points = REWARD if correct else 0
            if points:
                season = conn.execute(
                    "SELECT id FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1"
                ).fetchone()
                apply_points(
                    conn,
                    player_id,
                    points,
                    "cipher",
                    f"cipher:{player_id}:{day.isoformat()}",
                    int(season["id"]) if season else None,
                    now,
                )
            try:
                conn.execute(
                    """
                    INSERT INTO cipher_guesses (player_id, day, guess, correct, points, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (player_id, day, cleaned, correct, points, now),
                )
            except Exception as exc:
                from psycopg.errors import UniqueViolation

                if isinstance(exc, UniqueViolation):
                    raise GameError("repeat_guess", "That guess was already tried.", 409) from exc
                raise
            player = reload_player(conn, player_id)
            response = _payload(conn, player, day, correct, points, False, now)
            store_idempotency(conn, player_id, "cipher", key, response, now)
            return response


def _payload(conn, player, day: date, correct: bool, points: int, already: bool, now: datetime) -> dict:
    view = cipher_view(conn, int(player["id"]), now)
    return {
        "replayed": False,
        "correct": correct,
        "alreadySolved": already,
        "points": points,
        "playerPoints": int(player["points"]),
        "cipher": view,
        "serverTime": now.isoformat(),
    }

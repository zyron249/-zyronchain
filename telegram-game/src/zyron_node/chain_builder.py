"""Chain Builder. The client sends the drop order. The server scores it."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta

BLOCKS = ("blue", "chrome", "void", "ice", "gold")
LENGTH = 5
POINTS_PER_BLOCK = 4
DAILY_CAP = 40
MAX_ATTEMPTS = 6
MIN_SECONDS = 2
BLOCK_SET = set(BLOCKS)


def sequence_for(player_id: int, day, attempt: int) -> tuple[str, ...]:
    raw = hashlib.sha256(f"zyron-chain-v1:{player_id}:{day.isoformat()}:{attempt}".encode()).digest()
    return tuple(BLOCKS[raw[i] % len(BLOCKS)] for i in range(LENGTH))


def prefix_correct(expected: tuple[str, ...], placed: list[str]) -> int:
    matched = 0
    for want, got in zip(expected, placed):
        if want != got:
            break
        matched += 1
    return matched


def _split(value: str | None) -> list[str]:
    if not value:
        return []
    return [part for part in value.split(",") if part]


def _daily(conn, player_id: int, day) -> dict:
    row = conn.execute(
        """
        SELECT COALESCE(SUM(points), 0) AS used, COUNT(*) AS attempts
        FROM chain_builder_runs
        WHERE player_id = %s AND day = %s
        """,
        (player_id, day),
    ).fetchone()
    used = int(row["used"])
    return {
        "cap": DAILY_CAP,
        "used": used,
        "remaining": max(0, DAILY_CAP - used),
        "attemptsUsed": int(row["attempts"]),
        "attemptsMax": MAX_ATTEMPTS,
    }


def _open_run(conn, player_id: int, day):
    return conn.execute(
        """
        SELECT * FROM chain_builder_runs
        WHERE player_id = %s AND day = %s AND settled_at IS NULL
        ORDER BY attempt DESC
        LIMIT 1
        """,
        (player_id, day),
    ).fetchone()


def _open_payload(row) -> dict | None:
    if row is None:
        return None
    return {
        "attempt": int(row["attempt"]),
        "sequence": _split(row["sequence"]),
        "startedAt": row["started_at"].isoformat(),
    }


def chain_view(conn, player_id: int, now: datetime) -> dict:
    day = now.date()
    return {
        "length": LENGTH,
        "blocks": list(BLOCKS),
        "pointsPerBlock": POINTS_PER_BLOCK,
        "minSeconds": MIN_SECONDS,
        "daily": _daily(conn, player_id, day),
        "open": _open_payload(_open_run(conn, player_id, day)),
        "notice": "Off-chain Zyron Points. The server scores the stack. No conversion.",
        "serverTime": now.isoformat(),
    }


def _start_response(conn, player_id: int, row, now: datetime, replayed: bool) -> dict:
    return {
        "replayed": replayed,
        "attempt": int(row["attempt"]),
        "sequence": _split(row["sequence"]),
        "startedAt": row["started_at"].isoformat(),
        "minSeconds": MIN_SECONDS,
        "pointsPerBlock": POINTS_PER_BLOCK,
        "daily": _daily(conn, player_id, now.date()),
        "serverTime": now.isoformat(),
    }


def start(pool, player_id: int, key: str, now: datetime) -> dict:
    from zyron_node.game import GameError, lock_player, reject_if_banned, replay_of, require_key, store_idempotency

    require_key(key)
    day = now.date()
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "chain_start", key)
            if replay:
                return replay
            reject_if_banned(player)
            open_run = _open_run(conn, player_id, day)
            if open_run is None:
                daily = _daily(conn, player_id, day)
                if daily["remaining"] <= 0:
                    raise GameError("chain_cap", "Today's Chain Builder points are used up. Resets at 00:00 UTC.", 409)
                if daily["attemptsUsed"] >= MAX_ATTEMPTS:
                    raise GameError("chain_attempts", "Today's Chain Builder runs are used up. Resets at 00:00 UTC.", 409)
                attempt = daily["attemptsUsed"] + 1
                sequence = ",".join(sequence_for(player_id, day, attempt))
                open_run = conn.execute(
                    """
                    INSERT INTO chain_builder_runs (player_id, day, attempt, sequence, started_at)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    (player_id, day, attempt, sequence, now),
                ).fetchone()
            response = _start_response(conn, player_id, open_run, now, False)
            store_idempotency(conn, player_id, "chain_start", key, response, now)
            return response


def _check_placed(placed: list[str]) -> None:
    from zyron_node.game import GameError

    if not 1 <= len(placed) <= LENGTH:
        raise GameError("bad_order", "Drop between 1 and 5 blocks.", 400)
    if any(block not in BLOCK_SET for block in placed):
        raise GameError("bad_block", "Unknown block.", 400)


def finish(pool, player_id: int, key: str, attempt: int, placed: list[str], now: datetime) -> dict:
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
    _check_placed(placed)
    day = now.date()
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "chain_finish", key)
            if replay:
                return replay
            reject_if_banned(player)
            run = conn.execute(
                """
                SELECT * FROM chain_builder_runs
                WHERE player_id = %s AND day = %s AND attempt = %s
                FOR UPDATE
                """,
                (player_id, day, attempt),
            ).fetchone()
            if run is None:
                raise GameError("no_run", "Start a Chain Builder run first.", 404)
            expected = tuple(_split(run["sequence"]))
            if run["settled_at"] is not None:
                response = _finish_payload(conn, player, run, expected, _split(run["placed"]), int(run["points"]), True, now)
                store_idempotency(conn, player_id, "chain_finish", key, response, now)
                return response
            if now < run["started_at"] + timedelta(seconds=MIN_SECONDS):
                raise GameError("chain_too_fast", "That stack was sent too quickly.", 429, retry_after=1)
            matched = prefix_correct(expected, placed)
            raw = matched * POINTS_PER_BLOCK
            daily = _daily(conn, player_id, day)
            awarded = min(raw, daily["remaining"])
            if awarded > 0:
                season = conn.execute(
                    "SELECT id FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1"
                ).fetchone()
                apply_points(
                    conn,
                    player_id,
                    awarded,
                    "chain_builder",
                    f"chain:{player_id}:{day.isoformat()}:{attempt}",
                    int(season["id"]) if season else None,
                    now,
                )
            conn.execute(
                """
                UPDATE chain_builder_runs
                SET placed = %s, points = %s, settled_at = %s
                WHERE player_id = %s AND day = %s AND attempt = %s
                """,
                (",".join(placed), awarded, now, player_id, day, attempt),
            )
            player = reload_player(conn, player_id)
            response = _finish_payload(conn, player, run, expected, placed, awarded, False, now)
            store_idempotency(conn, player_id, "chain_finish", key, response, now)
            return response


def _finish_payload(conn, player, run, expected, placed, awarded: int, already: bool, now: datetime) -> dict:
    matched = prefix_correct(tuple(expected), list(placed))
    return {
        "replayed": False,
        "alreadySettled": already,
        "attempt": int(run["attempt"]),
        "correct": matched,
        "points": awarded,
        "playerPoints": int(player["points"]),
        "daily": _daily(conn, int(player["id"]), now.date()),
        "serverTime": now.isoformat(),
    }

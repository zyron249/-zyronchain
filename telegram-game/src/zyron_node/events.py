"""Shared network events. Damage and points are rolled on the server."""

from __future__ import annotations

import hashlib
from datetime import datetime

STRIKE_POINTS = 3
FINISHER_POINTS = 12
CLAIM_POINTS = 8
MAX_STRIKES = 6
POINT_CAP = 40


def kind_for(now: datetime) -> str | None:
    # 15:00 UTC test clocks sit outside both windows.
    if 18 <= now.hour < 20:
        return "block_storm"
    if 21 <= now.hour < 23:
        return "bug_monster"
    return None


def event_key(now: datetime, kind: str) -> str:
    return f"{now.date().isoformat()}:{kind}"


def damage_for(player_id: int, key: str, strike_no: int) -> int:
    raw = hashlib.sha256(f"zyron-event-v1:{player_id}:{key}:{strike_no}".encode()).digest()
    return 24 + (raw[0] % 17)


def _spec(kind: str) -> dict:
    if kind == "bug_monster":
        return {"hp": 120, "goal": 120, "mode": "hp"}
    return {"hp": 0, "goal": 40, "mode": "progress"}


def _ensure(conn, now: datetime):
    kind = kind_for(now)
    if kind is None:
        return None
    key = event_key(now, kind)
    row = conn.execute("SELECT * FROM network_events WHERE event_key = %s FOR UPDATE", (key,)).fetchone()
    if row is not None:
        return row
    spec = _spec(kind)
    return conn.execute(
        """
        INSERT INTO network_events (event_key, kind, hp, max_hp, progress, goal, created_at)
        VALUES (%s, %s, %s, %s, 0, %s, %s)
        ON CONFLICT (event_key) DO NOTHING
        RETURNING *
        """,
        (key, kind, spec["hp"], max(spec["hp"], 1), spec["goal"], now),
    ).fetchone() or conn.execute("SELECT * FROM network_events WHERE event_key = %s FOR UPDATE", (key,)).fetchone()


def _public(row, strikes: int, claimed: bool) -> dict:
    defeated = int(row["hp"]) <= 0 if row["kind"] == "bug_monster" else int(row["progress"]) >= int(row["goal"])
    return {
        "key": row["event_key"],
        "kind": row["kind"],
        "title": "Bug monster" if row["kind"] == "bug_monster" else "Block storm",
        "hp": int(row["hp"]),
        "maxHp": int(row["max_hp"]),
        "progress": int(row["progress"]),
        "goal": int(row["goal"]),
        "defeated": defeated,
        "yourStrikes": strikes,
        "claimed": claimed,
        "endsHint": "Shared by every builder online right now.",
    }


def _strikes(conn, player_id: int, key: str) -> int:
    return int(
        conn.execute(
            "SELECT COUNT(*) AS n FROM network_event_strikes WHERE player_id = %s AND event_key = %s",
            (player_id, key),
        ).fetchone()["n"]
    )


def _claimed(conn, player_id: int, key: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM network_event_claims WHERE player_id = %s AND event_key = %s",
            (player_id, key),
        ).fetchone()
        is not None
    )


def events_view(conn, player_id: int, now: datetime) -> dict:
    kind = kind_for(now)
    if kind is None:
        return {"active": None, "serverTime": now.isoformat()}
    row = _ensure(conn, now)
    return {
        "active": _public(row, _strikes(conn, player_id, row["event_key"]), _claimed(conn, player_id, row["event_key"])),
        "serverTime": now.isoformat(),
    }


def _spent(conn, player_id: int, key: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(points), 0) AS n FROM network_event_strikes WHERE player_id = %s AND event_key = %s",
        (player_id, key),
    ).fetchone()
    claim = conn.execute(
        "SELECT COALESCE(SUM(points), 0) AS n FROM network_event_claims WHERE player_id = %s AND event_key = %s",
        (player_id, key),
    ).fetchone()
    return int(row["n"]) + int(claim["n"])


def strike(pool, player_id: int, key: str, now: datetime) -> dict:
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
    if kind_for(now) is None:
        raise GameError("no_event", "No network event is live.", 409)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "event_strike", key)
            if replay:
                return replay
            reject_if_banned(player)
            row = _ensure(conn, now)
            strikes = _strikes(conn, player_id, row["event_key"])
            if strikes >= MAX_STRIKES:
                raise GameError("event_limited", "No strikes left for this event.", 429)
            defeated_before = int(row["hp"]) <= 0 if row["kind"] == "bug_monster" else int(row["progress"]) >= int(row["goal"])
            strike_no = strikes + 1
            damage = damage_for(player_id, row["event_key"], strike_no) if row["kind"] == "bug_monster" else 8
            gained = 0 if defeated_before else min(STRIKE_POINTS, max(0, POINT_CAP - _spent(conn, player_id, row["event_key"])))
            finisher = False
            if row["kind"] == "bug_monster":
                hp = max(0, int(row["hp"]) - damage)
                conn.execute("UPDATE network_events SET hp = %s WHERE event_key = %s", (hp, row["event_key"]))
                finisher = (not defeated_before) and hp == 0
            else:
                progress = min(int(row["goal"]), int(row["progress"]) + damage)
                conn.execute(
                    "UPDATE network_events SET progress = %s WHERE event_key = %s",
                    (progress, row["event_key"]),
                )
                finisher = (not defeated_before) and progress >= int(row["goal"])
            if finisher:
                gained = min(gained + FINISHER_POINTS, max(0, POINT_CAP - _spent(conn, player_id, row["event_key"])))
            if gained:
                season = conn.execute(
                    "SELECT id FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1"
                ).fetchone()
                apply_points(
                    conn,
                    player_id,
                    gained,
                    "network_event",
                    f"event:{player_id}:{row['event_key']}:{strike_no}",
                    int(season["id"]) if season else None,
                    now,
                )
            conn.execute(
                """
                INSERT INTO network_event_strikes (player_id, event_key, strike_no, damage, points, created_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (player_id, row["event_key"], strike_no, damage, gained, now),
            )
            fresh = conn.execute("SELECT * FROM network_events WHERE event_key = %s", (row["event_key"],)).fetchone()
            player = reload_player(conn, player_id)
            response = {
                "replayed": False,
                "damage": damage,
                "points": gained,
                "finisher": finisher,
                "playerPoints": int(player["points"]),
                "active": _public(fresh, strike_no, _claimed(conn, player_id, row["event_key"])),
                "serverTime": now.isoformat(),
            }
            store_idempotency(conn, player_id, "event_strike", key, response, now)
            return response


def claim_goal(pool, player_id: int, key: str, now: datetime) -> dict:
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
    if kind_for(now) is None:
        raise GameError("no_event", "No network event is live.", 409)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "event_claim", key)
            if replay:
                return replay
            reject_if_banned(player)
            row = _ensure(conn, now)
            defeated = int(row["hp"]) <= 0 if row["kind"] == "bug_monster" else int(row["progress"]) >= int(row["goal"])
            if not defeated:
                raise GameError("goal_open", "The community goal is still open.", 409)
            if _strikes(conn, player_id, row["event_key"]) < 1:
                raise GameError("no_strike", "Strike once before claiming the goal.", 409)
            if _claimed(conn, player_id, row["event_key"]):
                response = {"replayed": False, "alreadyClaimed": True, "points": 0, "playerPoints": int(player["points"]), "serverTime": now.isoformat()}
                store_idempotency(conn, player_id, "event_claim", key, response, now)
                return response
            room = max(0, POINT_CAP - _spent(conn, player_id, row["event_key"]))
            gained = min(CLAIM_POINTS, room)
            if gained <= 0:
                raise GameError("event_capped", "No more event points for this event.", 409)
            season = conn.execute(
                "SELECT id FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1"
            ).fetchone()
            apply_points(
                conn,
                player_id,
                gained,
                "network_event",
                f"eventclaim:{player_id}:{row['event_key']}",
                int(season["id"]) if season else None,
                now,
            )
            conn.execute(
                """
                INSERT INTO network_event_claims (player_id, event_key, points, created_at)
                VALUES (%s, %s, %s, %s)
                """,
                (player_id, row["event_key"], gained, now),
            )
            player = reload_player(conn, player_id)
            response = {
                "replayed": False,
                "alreadyClaimed": False,
                "points": gained,
                "playerPoints": int(player["points"]),
                "serverTime": now.isoformat(),
            }
            store_idempotency(conn, player_id, "event_claim", key, response, now)
            return response


def window_note(now: datetime) -> str:
    return "Block storm 18:00–20:00 UTC. Bug monster 21:00–23:00 UTC."

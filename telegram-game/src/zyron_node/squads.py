"""Opt-in builder squads and the weekly squad league. Not staff team accounts."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

MAX_MEMBERS = 5
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ]{1,22}[A-Za-z0-9]$")
TAG_RE = re.compile(r"^[A-Z0-9]{2,5}$")
BADGES = {1: "gold", 2: "silver", 3: "bronze"}


def week_bounds(now: datetime) -> tuple[datetime, datetime]:
    start_date = now.date() - timedelta(days=now.date().weekday())
    start = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
    return start, start + timedelta(days=7)


def _membership(conn, player_id: int):
    return conn.execute(
        """
        SELECT s.id, s.name, s.tag, m.role
        FROM squad_members m
        JOIN squads s ON s.id = m.squad_id
        WHERE m.player_id = %s
        """,
        (player_id,),
    ).fetchone()


def _roster(conn, squad_id: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT p.display_name, m.role
        FROM squad_members m
        JOIN players p ON p.id = m.player_id
        WHERE m.squad_id = %s
        ORDER BY m.role DESC, p.id ASC
        """,
        (squad_id,),
    ).fetchall()
    return [{"displayName": row["display_name"] or "Operator", "role": row["role"]} for row in rows]


def league_rows(conn, now: datetime) -> list[dict]:
    start, end = week_bounds(now)
    rows = conn.execute(
        """
        SELECT s.id, s.name, s.tag, COALESCE(SUM(l.amount), 0)::bigint AS score
        FROM squads s
        JOIN squad_members m ON m.squad_id = s.id
        LEFT JOIN point_ledger l
          ON l.player_id = m.player_id
         AND l.amount > 0
         AND l.created_at >= %s
         AND l.created_at < %s
        GROUP BY s.id, s.name, s.tag
        ORDER BY score DESC, s.id ASC
        LIMIT 10
        """,
        (start, end),
    ).fetchall()
    board = []
    for index, row in enumerate(rows, start=1):
        board.append(
            {
                "rank": index,
                "name": row["name"],
                "tag": row["tag"],
                "score": int(row["score"]),
                "badge": BADGES.get(index),
            }
        )
    return board


def squad_view(conn, player_id: int, now: datetime) -> dict:
    row = _membership(conn, player_id)
    yours = None
    if row is not None:
        yours = {
            "id": int(row["id"]),
            "name": row["name"],
            "tag": row["tag"],
            "role": row["role"],
            "members": _roster(conn, int(row["id"])),
        }
    iso = now.date().isocalendar()
    return {
        "yours": yours,
        "league": league_rows(conn, now),
        "maxMembers": MAX_MEMBERS,
        "week": f"{iso.year}-W{iso.week:02d}",
        "notice": "Weekly squad points are off-chain Zyron Points. No conversion.",
    }


def _reject_staff(player) -> None:
    from zyron_node.game import GameError

    if player.get("team_account"):
        raise GameError("staff_account", "Staff accounts do not join builder squads.", 409)


def create_squad(pool, player_id: int, name: str, tag: str, key: str, now: datetime) -> dict:
    from zyron_node.game import (
        GameError,
        active_season,
        load_levels,
        lock_player,
        reject_if_banned,
        reload_player,
        replay_of,
        require_key,
        store_idempotency,
        sync_rewards,
    )

    require_key(key)
    clean_name = " ".join((name or "").split())
    clean_tag = (tag or "").strip().upper()
    if not NAME_RE.fullmatch(clean_name):
        raise GameError("bad_name", "Squad name must be 3 to 24 letters or numbers.", 400)
    if not TAG_RE.fullmatch(clean_tag):
        raise GameError("bad_tag", "Squad tag must be 2 to 5 letters or numbers.", 400)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "squad_create", key)
            if replay:
                return replay
            reject_if_banned(player)
            _reject_staff(player)
            if _membership(conn, player_id) is not None:
                raise GameError("already_in_squad", "Leave your current squad first.", 409)
            if conn.execute("SELECT 1 FROM squads WHERE tag = %s", (clean_tag,)).fetchone():
                raise GameError("tag_taken", "That squad tag is already used.", 409)
            squad_id = conn.execute(
                "INSERT INTO squads (name, tag, created_at) VALUES (%s, %s, %s) RETURNING id",
                (clean_name, clean_tag, now),
            ).fetchone()["id"]
            conn.execute(
                """
                INSERT INTO squad_members (player_id, squad_id, role, joined_at)
                VALUES (%s, %s, 'captain', %s)
                """,
                (player_id, squad_id, now),
            )
            levels = load_levels(conn, player_id)
            season = active_season(conn)
            _, achievements = sync_rewards(
                conn, reload_player(conn, player_id), levels, now, season["id"] if season else None
            )
            player = reload_player(conn, player_id)
            response = {
                "replayed": False,
                "squad": squad_view(conn, player_id, now),
                "points": int(player["points"]),
                "achievementsUnlocked": achievements,
                "serverTime": now.isoformat(),
            }
            store_idempotency(conn, player_id, "squad_create", key, response, now)
            return response


def join_squad(pool, player_id: int, tag: str, key: str, now: datetime) -> dict:
    from zyron_node.game import GameError, lock_player, reject_if_banned, replay_of, require_key, store_idempotency

    require_key(key)
    clean_tag = (tag or "").strip().upper()
    if not TAG_RE.fullmatch(clean_tag):
        raise GameError("bad_tag", "Squad tag must be 2 to 5 letters or numbers.", 400)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "squad_join", key)
            if replay:
                return replay
            reject_if_banned(player)
            _reject_staff(player)
            if _membership(conn, player_id) is not None:
                raise GameError("already_in_squad", "Leave your current squad first.", 409)
            squad = conn.execute("SELECT id FROM squads WHERE tag = %s FOR UPDATE", (clean_tag,)).fetchone()
            if squad is None:
                raise GameError("no_squad", "No squad uses that tag.", 404)
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM squad_members WHERE squad_id = %s",
                (squad["id"],),
            ).fetchone()["n"]
            if int(count) >= MAX_MEMBERS:
                raise GameError("squad_full", "That squad is full.", 409)
            conn.execute(
                """
                INSERT INTO squad_members (player_id, squad_id, role, joined_at)
                VALUES (%s, %s, 'member', %s)
                """,
                (player_id, squad["id"], now),
            )
            response = {
                "replayed": False,
                "squad": squad_view(conn, player_id, now),
                "serverTime": now.isoformat(),
            }
            store_idempotency(conn, player_id, "squad_join", key, response, now)
            return response


def leave_squad(pool, player_id: int, key: str, now: datetime) -> dict:
    from zyron_node.game import GameError, lock_player, reject_if_banned, replay_of, require_key, store_idempotency

    require_key(key)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "squad_leave", key)
            if replay:
                return replay
            reject_if_banned(player)
            row = _membership(conn, player_id)
            if row is None:
                raise GameError("no_squad", "You are not in a squad.", 404)
            others = conn.execute(
                "SELECT COUNT(*) AS n FROM squad_members WHERE squad_id = %s AND player_id <> %s",
                (row["id"], player_id),
            ).fetchone()["n"]
            if row["role"] == "captain" and int(others) > 0:
                raise GameError("captain_stays", "A captain leaves only after the squad is empty.", 409)
            conn.execute("DELETE FROM squad_members WHERE player_id = %s", (player_id,))
            if int(others) == 0:
                conn.execute("DELETE FROM squads WHERE id = %s", (row["id"],))
            response = {
                "replayed": False,
                "squad": squad_view(conn, player_id, now),
                "serverTime": now.isoformat(),
            }
            store_idempotency(conn, player_id, "squad_leave", key, response, now)
            return response

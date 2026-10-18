"""Seven-day quest chain paid once per UTC day inside the daily streak claim."""

from __future__ import annotations

from datetime import datetime, timedelta

LENGTH = 7
REWARDS = (0, 2, 2, 3, 3, 4, 5, 8)


def chain_progress(conn, player_id: int, today) -> dict:
    last = conn.execute(
        """
        SELECT anchor, day_index, created_at
        FROM streak_chain_claims
        WHERE player_id = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (player_id,),
    ).fetchone()
    day = 0
    if last is not None:
        claimed_on = last["anchor"] + timedelta(days=int(last["day_index"]) - 1)
        if claimed_on == today or claimed_on == today - timedelta(days=1):
            day = int(last["day_index"])
    return {"day": day, "length": LENGTH, "rewards": list(REWARDS[1:])}


def advance_streak_chain(conn, player_id: int, season_id: int | None, now: datetime) -> dict:
    from zyron_node.game import apply_points

    today = now.date()
    last = conn.execute(
        """
        SELECT anchor, day_index
        FROM streak_chain_claims
        WHERE player_id = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (player_id,),
    ).fetchone()
    anchor = today
    day = 1
    if last is not None:
        claimed_on = last["anchor"] + timedelta(days=int(last["day_index"]) - 1)
        if claimed_on == today - timedelta(days=1) and int(last["day_index"]) < LENGTH:
            anchor = last["anchor"]
            day = int(last["day_index"]) + 1
    points = REWARDS[day]
    apply_points(
        conn,
        player_id,
        points,
        "streak_chain",
        f"streakchain:{player_id}:{today.isoformat()}",
        season_id,
        now,
    )
    conn.execute(
        """
        INSERT INTO streak_chain_claims (player_id, anchor, day_index, points, created_at)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (player_id, anchor, day, points, now),
    )
    return {"day": day, "length": LENGTH, "points": points, "title": f"7-day chain day {day}"}

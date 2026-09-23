"""Append-only activity ledger for a future fair distribution.

Game code may insert rows. It must not update or delete them. A database
trigger rejects UPDATE and DELETE. Lifetime distribution math sums only
``points_earned`` and ``backfill_snapshot`` amounts. Other event types may
store a related amount for readability; do not add those into a payout total,
and do not add ``point_ledger`` on top of a backfill row.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime, timezone

from psycopg.types.json import Json

from zyron_node.tiers import public_tier, threshold_payload, tier_for

LEDGER_NOTE = (
    "Zyron Points are off-chain gameplay points. This export is not a payout "
    "and does not transfer ZYN or Zyrum. Sum only points_earned and "
    "backfill_snapshot amounts. backfill_snapshot is a one-time seed of "
    "players.lifetime_points when the ledger was introduced, not a reconstructed "
    "earn history."
)

# Event types that contribute to lifetime points. rank_snapshot.amount is a
# rank, not points. chest/quest/daily rows repeat a payout already stored as
# points_earned.
LIFETIME_EVENT_TYPES = ("points_earned", "backfill_snapshot")


def append_activity(
    conn,
    player_id: int,
    telegram_id: int,
    event_type: str,
    amount: int | None,
    metadata: dict,
    now: datetime,
) -> None:
    conn.execute(
        """
        INSERT INTO activity_ledger (player_id, telegram_id, event_type, amount, metadata, created_at)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (player_id, int(telegram_id), event_type, amount, Json(metadata or {}), now),
    )


def append_activity_for_player(
    conn,
    player_id: int,
    event_type: str,
    amount: int | None,
    metadata: dict,
    now: datetime,
) -> None:
    row = conn.execute("SELECT telegram_id FROM players WHERE id = %s", (player_id,)).fetchone()
    if row is None:
        raise LookupError(f"player {player_id} is missing")
    append_activity(conn, player_id, int(row["telegram_id"]), event_type, amount, metadata, now)


def seed_opening_ledger(conn, at: datetime | None = None) -> dict[str, int]:
    """One-time seed for players who already had lifetime points before this ledger.

    Safe to call once, immediately after the table exists and before new
    ``points_earned`` rows. A player who already has ``points_earned`` or
    ``backfill_snapshot`` is skipped so the seed cannot double-count.
    """
    stamp = at or datetime.now(timezone.utc)
    backfill = conn.execute(
        """
        INSERT INTO activity_ledger (player_id, telegram_id, event_type, amount, metadata, created_at)
        SELECT
            p.id,
            p.telegram_id,
            'backfill_snapshot',
            p.lifetime_points,
            jsonb_build_object(
                'source', 'players.lifetime_points',
                'note', 'One-time seed of the lifetime balance when the activity ledger was introduced. Not a reconstructed earn history.',
                'pointsBalance', p.points,
                'nodeLevel', p.node_level
            ),
            %s
        FROM players p
        WHERE p.lifetime_points > 0
          AND NOT EXISTS (
              SELECT 1 FROM activity_ledger a
              WHERE a.player_id = p.id
                AND a.event_type IN ('backfill_snapshot', 'points_earned')
          )
        """,
        (stamp,),
    )
    ranks = conn.execute(
        """
        INSERT INTO activity_ledger (player_id, telegram_id, event_type, amount, metadata, created_at)
        SELECT
            s.id,
            s.telegram_id,
            'rank_snapshot',
            s.rank,
            jsonb_build_object(
                'board', 'alltime',
                'score', s.lifetime_points,
                'source', 'migration_opening',
                'note', 'Opening all-time rank when the activity ledger was introduced. Not a reconstructed history.'
            ),
            %s
        FROM (
            SELECT
                p.id,
                p.telegram_id,
                p.lifetime_points,
                ROW_NUMBER() OVER (ORDER BY p.lifetime_points DESC, p.id ASC)::bigint AS rank
            FROM players p
            WHERE p.lifetime_points > 0
        ) s
        WHERE NOT EXISTS (
            SELECT 1 FROM activity_ledger a
            WHERE a.player_id = s.id
              AND a.event_type = 'rank_snapshot'
              AND a.metadata->>'source' = 'migration_opening'
        )
        """,
        (stamp,),
    )
    return {"backfill": int(backfill.rowcount), "rankSnapshots": int(ranks.rowcount)}


def activity_counts(conn) -> list[dict]:
    rows = conn.execute(
        """
        SELECT event_type, COUNT(*)::bigint AS n, COALESCE(SUM(amount), 0)::bigint AS amount
        FROM activity_ledger
        GROUP BY event_type
        ORDER BY event_type ASC
        """
    ).fetchall()
    return [
        {"eventType": row["event_type"], "count": int(row["n"]), "amount": int(row["amount"])}
        for row in rows
    ]


def distribution_cutoff(conn, cutoff: datetime, *, limit: int = 20000) -> dict:
    """Airdrop-shaped snapshot. Not a payout.

    Lifetime points are the sum of ``points_earned`` and ``backfill_snapshot``
    rows with ``created_at <= cutoff``. Rank is that total, ties broken by
    player id ascending — the same order as the all-time board.
    """
    rows = conn.execute(
        """
        WITH totals AS (
            SELECT player_id, SUM(amount)::bigint AS lifetime_points
            FROM activity_ledger
            WHERE event_type IN ('points_earned', 'backfill_snapshot')
              AND amount IS NOT NULL
              AND created_at <= %s
            GROUP BY player_id
        ),
        ranked AS (
            SELECT
                t.lifetime_points,
                p.id,
                p.telegram_id,
                p.display_name,
                ROW_NUMBER() OVER (ORDER BY t.lifetime_points DESC, p.id ASC)::int AS rank
            FROM totals t
            JOIN players p ON p.id = t.player_id
            WHERE t.lifetime_points > 0
        )
        SELECT lifetime_points, id, telegram_id, display_name, rank
        FROM ranked
        ORDER BY rank ASC
        LIMIT %s
        """,
        (cutoff, limit + 1),
    ).fetchall()
    truncated = len(rows) > limit
    visible = rows[:limit]
    standings = []
    for row in visible:
        lifetime = int(row["lifetime_points"])
        spec = tier_for(lifetime)
        standings.append(
            {
                "playerId": int(row["id"]),
                "telegramId": int(row["telegram_id"]),
                "displayName": row["display_name"] or f"Node {row['id']}",
                "lifetimePoints": lifetime,
                "tier": public_tier(spec),
                "rankAtCutoff": int(row["rank"]),
            }
        )
    return {
        "kind": "zyron-node-distribution-cutoff",
        "version": 1,
        "cutoff": cutoff.isoformat().replace("+00:00", "Z"),
        "metric": "lifetimePoints",
        "automaticPayout": False,
        "conversionRate": None,
        "truncated": truncated,
        "note": LEDGER_NOTE,
        "thresholds": threshold_payload(),
        "rows": standings,
    }


def distribution_csv(payload: dict) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["player_id", "telegram_id", "lifetime_points", "tier", "rank_at_cutoff"])
    for row in payload["rows"]:
        tier = row.get("tier") or {}
        writer.writerow(
            [
                row["playerId"],
                row["telegramId"],
                row["lifetimePoints"],
                tier.get("id") or "",
                row["rankAtCutoff"],
            ]
        )
    return buffer.getvalue()


def rank_reigns(conn, rank: int, as_of: datetime) -> list[dict]:
    """Who held an all-time rank, and for how long, from rank_snapshot rows.

    The clock starts at the first snapshot. Opening snapshots written when the
    ledger was introduced are not a reconstructed history before that moment.
    """
    if rank < 1:
        raise ValueError("rank must be positive")
    rows = conn.execute(
        """
        SELECT a.player_id, a.telegram_id, a.amount, a.created_at, p.display_name
        FROM activity_ledger a
        JOIN players p ON p.id = a.player_id
        WHERE a.event_type = 'rank_snapshot'
          AND COALESCE(a.metadata->>'board', 'alltime') = 'alltime'
          AND a.amount = %s
          AND a.created_at <= %s
        ORDER BY a.created_at ASC, a.id ASC
        """,
        (rank, as_of),
    ).fetchall()
    reigns: list[dict] = []
    for row in rows:
        player_id = int(row["player_id"])
        if reigns and reigns[-1]["playerId"] == player_id and reigns[-1]["until"] is None:
            continue
        if reigns and reigns[-1]["until"] is None:
            _close_reign(reigns[-1], row["created_at"])
        reigns.append(
            {
                "playerId": player_id,
                "telegramId": int(row["telegram_id"]),
                "displayName": row["display_name"] or f"Node {row['player_id']}",
                "rank": rank,
                "from": _iso(row["created_at"]),
                "until": None,
                "seconds": None,
                "open": True,
                "_start": row["created_at"],
            }
        )
    if reigns and reigns[-1]["until"] is None:
        start = reigns[-1]["_start"]
        reigns[-1]["seconds"] = max(0, int((as_of - start).total_seconds()))
        reigns[-1]["open"] = True
    for item in reigns:
        item.pop("_start", None)
    return reigns


def ledger_summary(conn, now: datetime) -> dict:
    cutoff = distribution_cutoff(conn, now)
    return {
        "generatedAt": cutoff["cutoff"],
        "metric": "lifetimePoints",
        "automaticPayout": False,
        "conversionRate": None,
        "note": LEDGER_NOTE,
        "thresholds": threshold_payload(),
        "activityCounts": activity_counts(conn),
        "lifetime": cutoff["rows"],
        "truncated": cutoff["truncated"],
        "rankOneReigns": rank_reigns(conn, 1, now),
    }


def _close_reign(reign: dict, until: datetime) -> None:
    reign["until"] = _iso(until)
    reign["seconds"] = max(0, int((until - reign["_start"]).total_seconds()))
    reign["open"] = False


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")

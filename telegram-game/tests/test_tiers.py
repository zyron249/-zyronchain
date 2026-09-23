"""Tier thresholds and the append-only activity ledger."""

from datetime import timedelta
from pathlib import Path

import pytest
from psycopg.errors import RaiseException

from tests.test_api import NOW, auth
from zyron_node.db import split_sql
from zyron_node.game import apply_points
from zyron_node.ledger import seed_opening_ledger
from zyron_node.tiers import (
    TIERS,
    next_tier,
    tier_for,
    tier_progress,
    tier_race_line,
    tiers_crossed,
)


def test_tier_thresholds_follow_lifetime_points_and_do_not_reset():
    assert [spec.id for spec in TIERS] == ["bronze", "silver", "gold", "diamond"]
    assert [spec.min_lifetime_points for spec in TIERS] == [250, 2_500, 15_000, 60_000]
    assert tier_for(0) is None
    assert tier_for(249) is None
    assert tier_for(250).id == "bronze"
    assert tier_for(2_499).id == "bronze"
    assert tier_for(2_500).id == "silver"
    assert tier_for(14_999).id == "silver"
    assert tier_for(15_000).id == "gold"
    assert tier_for(59_999).id == "gold"
    assert tier_for(60_000).id == "diamond"
    assert tier_for(1_000_000).id == "diamond"
    assert next_tier(60_000) is None
    assert tiers_crossed(0, 249) == []
    assert [spec.id for spec in tiers_crossed(0, 2_500)] == ["bronze", "silver"]
    assert tiers_crossed(2_500, 2_500) == []
    assert tiers_crossed(3_000, 2_999) == []
    start = tier_progress(100)
    assert start["metric"] == "lifetimePoints"
    assert start["floor"] == 0
    assert start["ceiling"] == 250
    assert start["pointsToNext"] == 150
    assert start["ratio"] == 0.4
    held = tier_progress(60_000)
    assert held["ceiling"] is None
    assert held["pointsToNext"] == 0
    assert held["ratio"] == 1.0
    assert "250 lifetime Zyron Points to Bronze (Bronz)." == tier_race_line(0)
    assert "2250 lifetime Zyron Points from Bronze to Silver." == tier_race_line(250)
    assert tier_race_line(60_000).startswith("Diamond is the top tier.")


def test_activity_ledger_migration_keeps_the_trigger_body_intact():
    sql = Path("migrations/003_activity_ledger.sql").read_text(encoding="utf-8")
    parts = split_sql(sql)
    trigger = [part for part in parts if "activity_ledger_reject_mutation" in part and "BEGIN" in part]
    assert len(trigger) == 1
    assert "RAISE EXCEPTION 'activity_ledger is append-only'" in trigger[0]
    assert "CREATE INDEX activity_ledger_player_time" in sql
    assert "CREATE INDEX activity_ledger_type_time" in sql


def test_profile_and_board_expose_tier_fields(client):
    headers = auth(501)
    me = client.get("/api/me", headers=headers)
    assert me.status_code == 200, me.text
    player = me.json()["player"]
    assert player["tier"] is None
    assert player["nextTier"]["id"] == "bronze"
    assert player["tierProgress"]["metric"] == "lifetimePoints"
    assert player["tierProgress"]["pointsToNext"] == 250
    assert [item["id"] for item in player["thresholds"]] == ["bronze", "silver", "gold", "diamond"]
    meta = client.get("/api/meta").json()
    assert meta["tierMetric"] == "lifetimePoints"
    assert meta["tierThresholds"] == player["thresholds"]
    board = client.get("/api/leaderboard?board=alltime", headers=headers).json()
    assert board["thresholds"][0]["minLifetimePoints"] == 250
    assert board["race"]["tier"] == "250 lifetime Zyron Points to Bronze (Bronz)."
    assert board["race"]["above"] == "No operator is ahead of you on this board yet."
    assert board["above"] is None
    assert {row["id"]: row["players"] for row in board["tierDistribution"]} == {
        "bronze": 0,
        "silver": 0,
        "gold": 0,
        "diamond": 0,
    }
    assert "tier-badge" in Path("frontend/app.js").read_text(encoding="utf-8")


def test_earn_appends_ledger_rows_and_rejects_mutation(client):
    headers = auth(502)
    me = client.get("/api/me", headers=headers).json()["player"]
    player_id = me["id"]
    pool = client.app.state.pool
    with pool.connection() as conn:
        with conn.transaction():
            paid = apply_points(conn, player_id, 2_500, "cycle", "tier-grant-2500", None, NOW)
            assert paid is True
            again = apply_points(conn, player_id, 2_500, "cycle", "tier-grant-2500", None, NOW)
            assert again is False
    profile = client.get("/api/me", headers=auth(502, NOW + timedelta(minutes=1))).json()["player"]
    assert profile["lifetimePoints"] == 2_500
    assert profile["tier"]["id"] == "silver"
    assert profile["nextTier"]["id"] == "gold"
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT event_type, amount, metadata
            FROM activity_ledger
            WHERE player_id = %s
            ORDER BY id ASC
            """,
            (player_id,),
        ).fetchall()
        types = [row["event_type"] for row in rows]
        assert types.count("points_earned") == 1
        assert rows[0]["amount"] == 2_500
        assert rows[0]["metadata"]["source"] == "cycle"
        assert types.count("tier_upgraded") == 2
        assert [row["metadata"]["tierId"] for row in rows if row["event_type"] == "tier_upgraded"] == ["bronze", "silver"]
        assert any(row["event_type"] == "rank_snapshot" and int(row["amount"]) == 1 for row in rows)
        original = rows[0]["amount"]
        with pytest.raises(RaiseException, match="append-only"):
            with conn.transaction():
                conn.execute(
                    "UPDATE activity_ledger SET amount = 1 WHERE player_id = %s AND event_type = 'points_earned'",
                    (player_id,),
                )
        with pytest.raises(RaiseException, match="append-only"):
            with conn.transaction():
                conn.execute("DELETE FROM activity_ledger WHERE player_id = %s", (player_id,))
        kept = conn.execute(
            "SELECT amount FROM activity_ledger WHERE player_id = %s AND event_type = 'points_earned'",
            (player_id,),
        ).fetchone()
        assert int(kept["amount"]) == original
    board = client.get("/api/leaderboard?board=alltime", headers=headers).json()
    assert board["me"]["tier"]["id"] == "silver"
    assert board["entries"][0]["you"] is True
    assert board["entries"][0]["tier"]["id"] == "silver"
    assert board["race"]["above"] == "You hold #1 on this board."
    assert board["tierDistribution"][1]["players"] == 1
    source = Path("src/zyron_node").read_text(encoding="utf-8") if False else "\n".join(
        path.read_text(encoding="utf-8") for path in Path("src/zyron_node").glob("*.py")
    )
    assert "UPDATE activity_ledger" not in source
    assert "DELETE FROM activity_ledger" not in source


def test_backfill_seed_and_cutoff_export(client):
    headers = auth(503)
    player = client.get("/api/me", headers=headers).json()["player"]
    pool = client.app.state.pool
    with pool.connection() as conn:
        with conn.transaction():
            conn.execute(
                "UPDATE players SET points = 800, lifetime_points = 800 WHERE id = %s",
                (player["id"],),
            )
            seeded = seed_opening_ledger(conn, NOW)
            assert seeded == {"backfill": 1, "rankSnapshots": 1}
            assert seed_opening_ledger(conn, NOW) == {"backfill": 0, "rankSnapshots": 0}
            apply_points(conn, player["id"], 50, "quest", "after-backfill-50", None, NOW + timedelta(minutes=5))
    admin = {"Authorization": "Bearer test-admin-token", "X-Test-Now": (NOW + timedelta(hours=1)).isoformat()}
    assert client.get("/api/admin/ledger/summary").status_code == 401
    summary = client.get("/api/admin/ledger/summary", headers=admin)
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["automaticPayout"] is False
    assert body["conversionRate"] is None
    counts = {row["eventType"]: row["count"] for row in body["activityCounts"]}
    assert counts["backfill_snapshot"] >= 1
    assert counts["points_earned"] >= 1
    mine = [row for row in body["lifetime"] if row["playerId"] == player["id"]]
    assert len(mine) == 1
    assert mine[0]["telegramId"] == 503
    assert mine[0]["lifetimePoints"] == 850
    assert mine[0]["tier"]["id"] == "bronze"
    assert mine[0]["rankAtCutoff"] == 1
    assert body["rankOneReigns"][0]["playerId"] == player["id"]
    assert body["rankOneReigns"][0]["open"] is True
    early = client.get(
        "/api/admin/ledger/cutoff",
        params={"at": (NOW - timedelta(days=1)).isoformat()},
        headers=admin,
    )
    assert early.status_code == 200
    assert all(row["playerId"] != player["id"] for row in early.json()["rows"])
    csv_body = client.get("/api/admin/ledger/cutoff.csv", headers=admin)
    assert csv_body.status_code == 200
    assert "text/csv" in csv_body.headers["content-type"]
    header, *lines = [line for line in csv_body.text.strip().splitlines() if line]
    assert header == "player_id,telegram_id,lifetime_points,tier,rank_at_cutoff"
    assert any(line.startswith(f"{player['id']},503,850,bronze,1") for line in lines)
    bad = client.get("/api/admin/ledger/cutoff", params={"at": "tomorrow"}, headers=admin)
    assert bad.status_code == 400
    opened = client.post("/api/chests/open", json={"id": "daily"}, headers=auth(503, NOW + timedelta(hours=2)))
    assert opened.status_code == 200, opened.text
    with pool.connection() as conn:
        events = {
            row["event_type"]
            for row in conn.execute(
                "SELECT event_type FROM activity_ledger WHERE player_id = %s",
                (player["id"],),
            ).fetchall()
        }
    assert "daily_claim" in events
    assert "chest_opened" in events
    assert "points_earned" in events

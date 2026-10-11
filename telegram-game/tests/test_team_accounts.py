"""Team/project accounts play normally but are never ranked or reward-eligible."""

from datetime import datetime, timedelta, timezone

import pytest

from tests.test_community import SUNDAY, SATURDAY, FakeTelegram, auth, build_blocks
from zyron_node import community
from zyron_node.config import ConfigError, team_telegram_ids
from zyron_node.db import apply_migrations
from zyron_node.game import sync_team_accounts

ADMIN = {"Authorization": "Bearer test-admin-token"}
TEAM = 951
ALEX = 952
SASRI = 953


def mark_team(client, telegram_id, team=True, when=SUNDAY):
    with client.app.state.pool.connection() as conn:
        player_id = conn.execute("SELECT id FROM players WHERE telegram_id = %s", (telegram_id,)).fetchone()["id"]
    res = client.post(
        f"/api/admin/players/{player_id}/team",
        json={"team": team},
        headers={**ADMIN, "X-Test-Now": when.isoformat()},
    )
    assert res.status_code == 200, res.text
    assert res.json()["teamAccount"] is team
    return player_id


def seed_three(client, start):
    build_blocks(client, TEAM, start, 5)
    build_blocks(client, ALEX, start + timedelta(minutes=5), 3)
    build_blocks(client, SASRI, start + timedelta(minutes=10), 1)


def test_team_ids_env_parsing():
    assert team_telegram_ids("") == ()
    assert team_telegram_ids("5516800744, 42 42;7") == (5516800744, 42, 7)
    for bad in ("abc", "-5", "0", "1" * 21):
        with pytest.raises(ConfigError):
            team_telegram_ids(bad)


def test_migration_is_idempotent(client):
    with client.app.state.pool.connection() as conn:
        with conn.transaction():
            conn.execute("DELETE FROM schema_migrations WHERE version = '006_team_accounts.sql'")
            assert apply_migrations(conn) == ["006_team_accounts.sql"]
            assert apply_migrations(conn) == []
        cols = {
            row["column_name"]
            for row in conn.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'players'"
            ).fetchall()
        }
    assert {"team_account", "team_marked_at"} <= cols


def test_admin_endpoint_requires_token_and_lists_team(client):
    client.get("/api/me", headers=auth(TEAM, SATURDAY))
    assert client.post("/api/admin/players/1/team", json={"team": True}).status_code == 401
    assert client.get("/api/admin/team").status_code == 401
    player_id = mark_team(client, TEAM)
    listed = client.get("/api/admin/team", headers=ADMIN).json()["players"]
    assert [p["id"] for p in listed] == [player_id]
    assert listed[0]["telegramId"] == TEAM
    found = client.get(f"/api/admin/players?q={TEAM}", headers=ADMIN).json()["players"]
    assert found[0]["teamAccount"] is True
    assert client.get("/api/admin/overview", headers=ADMIN).json()["teamAccounts"] == 1
    with client.app.state.pool.connection() as conn:
        actions = [r["action"] for r in conn.execute("SELECT action FROM admin_audit ORDER BY id").fetchall()]
    assert "player.team" in actions
    mark_team(client, TEAM, team=False)
    assert client.get("/api/admin/team", headers=ADMIN).json()["players"] == []


def test_env_sync_marks_existing_and_new_players(client, monkeypatch):
    pool = client.app.state.pool
    client.get("/api/me", headers=auth(TEAM, SATURDAY))
    now = datetime.now(timezone.utc)
    assert sync_team_accounts(pool, (TEAM, 999999), now) == 1
    assert sync_team_accounts(pool, (TEAM,), now) == 0  # already marked: no-op
    monkeypatch.setenv("TEAM_TELEGRAM_IDS", "954")
    fresh = client.get("/api/me", headers=auth(954, SATURDAY)).json()["player"]
    assert fresh["teamAccount"] is True
    other = client.get("/api/me", headers=auth(955, SATURDAY)).json()["player"]
    assert other["teamAccount"] is False and other["teamNote"] is None


def test_team_account_keeps_playing_but_is_not_ranked_in_app(client):
    start = SUNDAY - timedelta(hours=3)
    seed_three(client, start)
    mark_team(client, TEAM)
    later = start + timedelta(hours=1)
    # Still plays: cycles succeed and earn points for the account itself.
    build_blocks(client, TEAM, later, 1)
    me = client.get("/api/me", headers=auth(TEAM, later)).json()["player"]
    assert me["teamAccount"] is True and me["teamNote"] == "Team account, not ranked"
    assert all(me["rank"][board]["rank"] is None for board in ("daily", "weekly", "season", "alltime"))
    for board in ("daily", "weekly", "season", "alltime"):
        view = client.get(f"/api/leaderboard?board={board}", headers=auth(TEAM, later)).json()
        names = [e["playerId"] for e in view["entries"] + view["neighbors"]]
        assert me["id"] not in names
        assert view["population"] == 2
        assert view["me"]["teamAccount"] is True and view["me"]["onBoard"] is False and view["me"]["rank"] is None
        assert view["race"]["above"] == "Team account, not ranked"
    # Other players: the team account is gone and ranks close up.
    alex = client.get("/api/leaderboard?board=alltime", headers=auth(ALEX, later)).json()
    assert [e["rank"] for e in alex["entries"]] == [1, 2]
    assert alex["me"]["rank"] == 1 and alex["me"]["teamAccount"] is False
    assert alex["above"] is None
    alex_me = client.get("/api/me", headers=auth(ALEX, later)).json()["player"]
    assert alex_me["rank"]["alltime"]["rank"] == 1
    # The tier distribution only counts ranked players.
    assert sum(row["players"] for row in alex["tierDistribution"]) == sum(
        row["players"] for row in client.get("/api/leaderboard?board=alltime", headers=auth(SASRI, later)).json()["tierDistribution"]
    )


def test_team_account_left_out_of_group_boards_and_invite_contest(client):
    pool = client.app.state.pool
    settings = client.app.state.settings
    tuesday = SUNDAY - timedelta(days=5)
    build_blocks(client, TEAM, tuesday, 2)
    code = client.get("/api/me", headers=auth(TEAM, tuesday)).json()["player"]["referral"]["code"]
    client.get("/api/me", headers=auth(956, tuesday + timedelta(hours=1), start="ref_" + code))
    build_blocks(client, 956, tuesday + timedelta(hours=1), 2)
    build_blocks(client, TEAM, SATURDAY.replace(hour=9), 6)
    build_blocks(client, ALEX, SATURDAY.replace(hour=10), 3)
    with pool.connection() as conn:
        assert conn.execute("SELECT count(*)::int AS n FROM referrals WHERE status = 'rewarded'").fetchone()["n"] == 1
        conn.execute("UPDATE players SET display_name = 'Zyron Chain' WHERE telegram_id = %s", (TEAM,))
        conn.execute("UPDATE players SET display_name = 'Alex' WHERE telegram_id = %s", (ALEX,))
    before = community.leaderboard_post(pool, SUNDAY)[0]
    assert "Weekly invite contest" in before and "Zyron Chain —" in before
    mark_team(client, TEAM)
    built = community.leaderboard_post(pool, SUNDAY)
    text, detail = built
    with pool.connection() as conn:
        team_name = conn.execute("SELECT display_name FROM players WHERE telegram_id = %s", (TEAM,)).fetchone()["display_name"]
        alex_name = conn.execute("SELECT display_name FROM players WHERE telegram_id = %s", (ALEX,)).fetchone()["display_name"]
    assert team_name != alex_name
    assert detail["invites"] == 0 and "Weekly invite contest" not in text
    daily = text.split("\n\n")[0]
    assert alex_name in daily and "\U0001f947" in daily
    assert community.clean_name(team_name) + " —" not in text
    # Dry-run preview through the admin route matches.
    res = client.post("/api/admin/community/leaderboard", json={}, headers={**ADMIN, "X-Test-Now": SUNDAY.isoformat()})
    assert res.status_code == 200 and res.json()["dryRun"] is True
    assert community.clean_name(team_name) + " —" not in res.json()["text"]
    # Posting goes through the same filtered builder.
    tg = FakeTelegram()
    assert community.post_leaderboard(pool, settings, SUNDAY, tg)["posted"] is True
    assert community.clean_name(team_name) + " —" not in tg.of("sendMessage")[0]["text"]


def test_team_account_gets_no_quiz_reward(client):
    pool = client.app.state.pool
    settings = client.app.state.settings
    wednesday = datetime(2026, 10, 7, 16, 1, tzinfo=timezone.utc)
    community.post_quiz(pool, settings, wednesday, FakeTelegram())
    with pool.connection() as conn:
        rows = conn.execute("SELECT poll_id, correct_option FROM quiz_polls ORDER BY message_id").fetchall()
    client.get("/api/me", headers=auth(TEAM, wednesday))
    mark_team(client, TEAM, when=wednesday)
    at = wednesday + timedelta(minutes=5)
    answer = {"poll_id": rows[0]["poll_id"], "user": {"id": TEAM}, "option_ids": [rows[0]["correct_option"]]}
    assert community.record_quiz_answer(pool, answer, at) == {
        "recorded": True, "correct": True, "points": 0, "reason": "team_account",
    }
    assert client.get("/api/me", headers=auth(TEAM, at)).json()["player"]["points"] == 0


def test_team_account_left_out_of_exports_and_ledgers(client):
    start = SUNDAY - timedelta(hours=3)
    seed_three(client, start)
    team_id = mark_team(client, TEAM)
    admin = {**ADMIN, "X-Test-Now": (SUNDAY + timedelta(hours=1)).isoformat()}
    cutoff = client.get("/api/admin/ledger/cutoff", headers=admin).json()
    ids = [row["playerId"] for row in cutoff["rows"]]
    assert team_id not in ids and len(ids) == 2
    assert [row["rankAtCutoff"] for row in cutoff["rows"]] == [1, 2]
    assert "Team accounts" in cutoff["excludes"]
    csv_text = client.get("/api/admin/ledger/cutoff.csv", headers=admin).text
    assert f"\n{team_id},{TEAM}," not in csv_text
    summary = client.get("/api/admin/ledger/summary", headers=admin).json()
    assert team_id not in [row["playerId"] for row in summary["lifetime"]]
    assert all(reign["playerId"] != team_id for reign in summary["rankOneReigns"])
    snapshot = client.post("/api/admin/season/snapshot", headers=admin).json()
    assert team_id not in [row["playerId"] for row in snapshot["standings"]]
    assert [row["rank"] for row in snapshot["standings"]] == [1, 2]
    # Further play by the team account adds no rank snapshots.
    with client.app.state.pool.connection() as conn:
        before = conn.execute(
            "SELECT count(*)::int AS n FROM activity_ledger WHERE player_id = %s AND event_type = 'rank_snapshot'",
            (team_id,),
        ).fetchone()["n"]
    build_blocks(client, TEAM, start + timedelta(hours=2), 2)
    with client.app.state.pool.connection() as conn:
        after = conn.execute(
            "SELECT count(*)::int AS n FROM activity_ledger WHERE player_id = %s AND event_type = 'rank_snapshot'",
            (team_id,),
        ).fetchone()["n"]
    assert after == before


def test_frontend_shows_team_note():
    from pathlib import Path

    app = Path("frontend/app.js").read_text(encoding="utf-8")
    assert "Team account, not ranked" in app
    assert "p.teamAccount" in app and "me.teamAccount" in app
    admin = Path("frontend/admin.js").read_text(encoding="utf-8")
    assert "/team" in admin

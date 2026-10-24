"""Builder squads, the weekly league, and the 7-day chest chain."""

from datetime import timedelta

from tests.test_economy_and_auth import sign_init
from zyron_node.catalog import ACHIEVEMENTS_BY_ID
from zyron_node.economy import streak_reward

NOW = __import__("datetime").datetime(2026, 10, 5, 16, 0, tzinfo=__import__("datetime").timezone.utc)
ADMIN = {"Authorization": "Bearer test-admin-token"}


def auth(user_id, when=NOW):
    return {
        "Authorization": "tma " + sign_init(user_id, int(when.timestamp())),
        "X-Test-Now": when.isoformat(),
    }


def test_catalog_has_the_requested_badges():
    assert ACHIEVEMENTS_BY_ID["blocks_100"].title == "First 100 blocks"
    assert ACHIEVEMENTS_BY_ID["blocks_100"].target == 100
    assert ACHIEVEMENTS_BY_ID["team_captain"].title == "Team captain"
    assert ACHIEVEMENTS_BY_ID["streak_7"].metric == "longest_streak"


def test_squad_league_and_captain_badge(client):
    headers = auth(5701)
    created = client.post("/api/squads", json={"name": "North Pack", "tag": "wolf", "idempotencyKey": "squad-create-001"}, headers=headers)
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["squad"]["yours"]["role"] == "captain"
    assert body["squad"]["yours"]["tag"] == "WOLF"
    assert "team_captain" in body["achievementsUnlocked"]
    assert body["points"] == 20
    assert body["squad"]["league"][0]["badge"] == "gold"
    assert body["squad"]["league"][0]["score"] >= 20
    replay = client.post("/api/squads", json={"name": "North Pack", "tag": "wolf", "idempotencyKey": "squad-create-001"}, headers=headers)
    assert replay.json()["replayed"] is True
    assert replay.json()["points"] == 20
    again = client.post("/api/squads", json={"name": "Other Pack", "tag": "PACK", "idempotencyKey": "squad-create-002"}, headers=headers)
    assert again.status_code == 409
    for user, key in ((5702, "join-0002"), (5703, "join-0003"), (5704, "join-0004"), (5705, "join-0005")):
        joined = client.post("/api/squads/join", json={"tag": "WOLF", "idempotencyKey": key}, headers=auth(user))
        assert joined.status_code == 200, joined.text
        assert joined.json()["squad"]["yours"]["role"] == "member"
    full = client.post("/api/squads/join", json={"tag": "WOLF", "idempotencyKey": "join-0006"}, headers=auth(5706))
    assert full.status_code == 409
    assert full.json()["error"]["code"] == "squad_full"
    left = client.post("/api/squads/leave", json={"idempotencyKey": "leave-0002"}, headers=auth(5702))
    assert left.status_code == 200
    assert left.json()["squad"]["yours"] is None
    stayed = client.post("/api/squads/leave", json={"idempotencyKey": "leave-cap-01"}, headers=headers)
    assert stayed.status_code == 409
    assert stayed.json()["error"]["code"] == "captain_stays"
    me = client.get("/api/me", headers=headers).json()["player"]
    assert me["squad"]["yours"]["tag"] == "WOLF"
    assert any(item["id"] == "team_captain" and item["unlocked"] for item in client.get("/api/achievements", headers=headers).json()["achievements"])
    staff = auth(5707)
    assert client.get("/api/me", headers=staff).status_code == 200
    player_id = client.get("/api/me", headers=staff).json()["player"]["id"]
    marked = client.post(f"/api/admin/players/{player_id}/team", json={"team": True}, headers={**ADMIN, "X-Test-Now": NOW.isoformat()})
    assert marked.status_code == 200
    denied = client.post("/api/squads", json={"name": "Staff Pack", "tag": "STAF", "idempotencyKey": "squad-staff-01"}, headers=staff)
    assert denied.status_code == 409
    assert denied.json()["error"]["code"] == "staff_account"


def test_hundred_block_badge_and_streak_chain(client):
    headers = auth(5801)
    player_id = client.get("/api/me", headers=headers).json()["player"]["id"]
    with client.app.state.pool.connection() as conn:
        conn.execute("UPDATE players SET cycle_count = 100 WHERE id = %s", (player_id,))
    synced = client.post("/api/quests/sync", headers=headers)
    assert synced.status_code == 200, synced.text
    assert "blocks_100" in synced.json()["achievementsUnlocked"]
    first = client.post("/api/chests/open", json={"id": "daily"}, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["gained"] == streak_reward(1) + 5
    assert first.json()["chain"] == {"day": 1, "length": 7, "points": 2, "title": "7-day chain day 1"}
    replay = client.post("/api/chests/open", json={"id": "daily"}, headers=auth(5801, NOW + timedelta(hours=2)))
    assert replay.json()["replayed"] is True
    assert replay.json()["chain"] is None
    points = client.get("/api/me", headers=headers).json()["player"]["points"]
    assert client.get("/api/me", headers=auth(5801, NOW + timedelta(hours=3))).json()["player"]["points"] == points
    for day in range(2, 8):
        opened = client.post("/api/chests/open", json={"id": "daily"}, headers=auth(5801, NOW + timedelta(days=day - 1)))
        assert opened.status_code == 200, opened.text
        assert opened.json()["chain"]["day"] == day
        assert opened.json()["gained"] == streak_reward(day) + 5
    assert opened.json()["chain"]["points"] == 8
    reset = client.post("/api/chests/open", json={"id": "daily"}, headers=auth(5801, NOW + timedelta(days=7)))
    assert reset.json()["chain"]["day"] == 1
    profile = client.get("/api/me", headers=auth(5801, NOW + timedelta(days=7))).json()["player"]
    assert profile["streak"]["chain"]["day"] == 1
    assert profile["streak"]["chain"]["length"] == 7

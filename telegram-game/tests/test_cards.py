"""Share cards are issued only after the server confirms the achievement."""

import subprocess
from datetime import datetime, timezone

from tests.test_economy_and_auth import sign_init

NOW = datetime(2026, 10, 18, 16, 30, tzinfo=timezone.utc)
BANNED = ("miner", "airdrop", "invest", "price", "guarantee")


def auth(user_id, when=NOW):
    return {
        "Authorization": "tma " + sign_init(user_id, int(when.timestamp())),
        "X-Test-Now": when.isoformat(),
    }


def test_cards_module():
    result = subprocess.run(["node", "tests/cards.test.js"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "cards ok" in result.stdout


def test_locked_cards_are_refused_until_earned(client):
    headers = auth(6301)
    me = client.get("/api/me", headers=headers).json()["player"]
    listed = client.get("/api/cards", headers=headers)
    assert listed.status_code == 200, listed.text
    cards = listed.json()["cards"]
    assert [item["id"] for item in cards] == ["streak_7", "gold_node", "blocks_100", "team_captain"]
    assert all(item["earned"] is False and "line" not in item for item in cards)
    locked = client.get("/api/cards/streak_7", headers=headers)
    assert locked.status_code == 403
    assert locked.json()["error"]["code"] == "card_locked"
    assert client.get("/api/cards/not-a-card", headers=headers).status_code == 404
    with client.app.state.pool.connection() as conn:
        conn.execute(
            "UPDATE players SET longest_streak = 7, cycle_count = 100 WHERE id = %s",
            (me["id"],),
        )
        conn.execute(
            "UPDATE player_upgrades SET level = 20 WHERE player_id = %s AND module = 'cpu'",
            (me["id"],),
        )
    streak = client.get("/api/cards/streak_7", headers=headers)
    assert streak.status_code == 200, streak.text
    body = streak.json()
    assert body["title"] == "7-day streak"
    assert "7-day streak" in body["line"]
    lowered = streak.text.lower()
    for word in BANNED:
        assert word not in lowered
    gold = client.get("/api/cards/gold_node", headers=headers)
    assert gold.status_code == 200, gold.text
    assert gold.json()["title"] == "Gold node reached"
    blocks = client.get("/api/cards/blocks_100", headers=headers)
    assert blocks.json()["title"] == "First 100 blocks"
    assert "line" in blocks.json()
    captain = client.get("/api/cards/team_captain", headers=headers)
    assert captain.status_code == 403
    created = client.post(
        "/api/squads",
        json={"name": "Card Pack", "tag": "CARD", "idempotencyKey": "card-squad-001"},
        headers=headers,
    )
    assert created.status_code == 200, created.text
    opened = client.get("/api/cards/team_captain", headers=headers)
    assert opened.status_code == 200, opened.text
    assert opened.json()["title"] == "Team captain"
    ready = {item["id"]: item["earned"] for item in client.get("/api/cards", headers=headers).json()["cards"]}
    assert ready == {"streak_7": True, "gold_node": True, "blocks_100": True, "team_captain": True}

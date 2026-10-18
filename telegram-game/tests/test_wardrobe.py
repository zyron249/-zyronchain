"""Cosmetic wardrobe: points unlocks, equip rules, no gameplay effect."""

import shutil
import subprocess

from tests.test_economy_and_auth import sign_init
from zyron_node.economy import cycle_reward, empty_levels

NOW = __import__("datetime").datetime(2026, 10, 2, 12, 0, tzinfo=__import__("datetime").timezone.utc)


def auth(user_id):
    return {
        "Authorization": "tma " + sign_init(user_id, int(NOW.timestamp())),
        "X-Test-Now": NOW.isoformat(),
    }


def _grant(client, player_id, points=500):
    with client.app.state.pool.connection() as conn:
        conn.execute("UPDATE players SET points = %s WHERE id = %s", (points, player_id))


def test_wardrobe_module_and_shell():
    result = subprocess.run(["node", "tests/wardrobe.test.js"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert shutil.which("node")


def test_unlock_is_cosmetic_idempotent_and_capped(client):
    headers = auth(4401)
    me = client.get("/api/me", headers=headers).json()["player"]
    before_reward = me["cycleReward"]
    before_power = me["networkPower"]
    assert me["wardrobe"]["loadout"]["helmet"] == "stock"
    assert me["wardrobe"]["loadout"]["wolfMask"] is False
    player_id = me["id"]
    _grant(client, player_id, 500)
    body = {"item": "wolf_mask", "idempotencyKey": "wear-wolf-01"}
    first = client.post("/api/wardrobe/unlock", json=body, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["spent"] == 120
    assert first.json()["points"] == 380
    assert first.json()["wardrobe"]["items"]
    owned = [item for item in first.json()["wardrobe"]["items"] if item["id"] == "wolf_mask"][0]
    assert owned["owned"] is True
    replay = client.post("/api/wardrobe/unlock", json=body, headers=headers)
    assert replay.json()["replayed"] is True
    assert replay.json()["points"] == 380
    again = client.post("/api/wardrobe/unlock", json={"item": "wolf_mask", "idempotencyKey": "wear-wolf-02"}, headers=headers)
    assert again.json()["alreadyOwned"] is True
    assert again.json()["spent"] == 0
    assert again.json()["points"] == 380
    poor = auth(4402)
    poor_id = client.get("/api/me", headers=poor).json()["player"]["id"]
    _grant(client, poor_id, 10)
    denied = client.post("/api/wardrobe/unlock", json={"item": "pick_gold", "idempotencyKey": "wear-poor-01"}, headers=poor)
    assert denied.status_code == 409
    assert denied.json()["error"]["code"] == "insufficient_points"
    after = client.get("/api/me", headers=headers).json()["player"]
    assert after["cycleReward"] == before_reward == cycle_reward(empty_levels(), 0)
    assert after["networkPower"] == before_power
    assert after["level"] == 1


def test_equip_requires_ownership_and_replays(client):
    headers = auth(4403)
    player_id = client.get("/api/me", headers=headers).json()["player"]["id"]
    _grant(client, player_id, 400)
    locked = client.post(
        "/api/wardrobe/equip",
        json={"idempotencyKey": "equip-nope-01", "helmet": "crest", "pickaxe": "stock", "color": "electric", "wolfMask": False},
        headers=headers,
    )
    assert locked.status_code == 409
    assert client.post("/api/wardrobe/unlock", json={"item": "helmet_crest", "idempotencyKey": "wear-crest-01"}, headers=headers).status_code == 200
    assert client.post("/api/wardrobe/unlock", json={"item": "wolf_mask", "idempotencyKey": "wear-mask-01"}, headers=headers).status_code == 200
    equipped = client.post(
        "/api/wardrobe/equip",
        json={"idempotencyKey": "equip-yes-01", "helmet": "crest", "pickaxe": "stock", "color": "electric", "wolfMask": True},
        headers=headers,
    )
    assert equipped.status_code == 200, equipped.text
    assert equipped.json()["loadout"] == {"helmet": "crest", "pickaxe": "stock", "color": "electric", "wolfMask": True}
    replay = client.post(
        "/api/wardrobe/equip",
        json={"idempotencyKey": "equip-yes-01", "helmet": "stock", "pickaxe": "stock", "color": "electric", "wolfMask": False},
        headers=headers,
    )
    assert replay.json()["replayed"] is True
    assert replay.json()["loadout"]["helmet"] == "crest"
    profile = client.get("/api/me", headers=headers).json()["player"]["wardrobe"]["loadout"]
    assert profile["wolfMask"] is True
    unknown = client.post("/api/wardrobe/unlock", json={"item": "not_real", "idempotencyKey": "wear-bad-0001"}, headers=headers)
    assert unknown.status_code == 400

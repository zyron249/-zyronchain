"""Personal galaxy and the opt-in country map. Counts only, no precise location."""

import json
import subprocess
from datetime import datetime, timezone

from tests.test_economy_and_auth import sign_init

NOW = datetime(2026, 10, 18, 16, 0, tzinfo=timezone.utc)
ADMIN = {"Authorization": "Bearer test-admin-token", "X-Test-Now": NOW.isoformat()}


def auth(user_id, when=NOW):
    return {
        "Authorization": "tma " + sign_init(user_id, int(when.timestamp())),
        "X-Test-Now": when.isoformat(),
    }


def test_map_module():
    result = subprocess.run(["node", "tests/map.test.js"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "map ok" in result.stdout


def test_country_map_is_opt_in_aggregate(client):
    first = auth(6201)
    second = auth(6202)
    me = client.get("/api/me", headers=first).json()["player"]
    assert me["countryCode"] is None
    assert me["cycleCount"] == 0
    opened = client.get("/api/map", headers=first)
    assert opened.status_code == 200, opened.text
    body = opened.json()
    assert body["country"] is None
    assert body["world"] == []
    assert body["galaxy"]["blocks"] == 0
    dumped = json.dumps(body)
    for banned in ("latitude", "longitude", "geolocation", "telegram"):
        assert banned not in dumped
    saved = client.post(
        "/api/map/country",
        json={"country": "us", "idempotencyKey": "country-us-0001"},
        headers=first,
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["country"] == "US"
    assert saved.json()["map"]["world"][0]["builders"] == 1
    assert saved.json()["map"]["world"][0]["code"] == "US"
    replay = client.post(
        "/api/map/country",
        json={"country": "us", "idempotencyKey": "country-us-0001"},
        headers=first,
    )
    assert replay.json()["replayed"] is True
    assert replay.json()["country"] == "US"
    unknown = client.post(
        "/api/map/country",
        json={"country": "ZZ", "idempotencyKey": "country-zz-0001"},
        headers=first,
    )
    assert unknown.status_code == 400
    assert unknown.json()["error"]["code"] == "unknown_country"
    joined = client.post(
        "/api/map/country",
        json={"country": "jp", "idempotencyKey": "country-jp-0001"},
        headers=second,
    )
    assert joined.status_code == 200, joined.text
    codes = {row["code"]: row["builders"] for row in client.get("/api/map", headers=second).json()["world"]}
    assert codes == {"US": 1, "JP": 1}
    with client.app.state.pool.connection() as conn:
        conn.execute("UPDATE players SET cycle_count = 12 WHERE id = %s", (me["id"],))
    galaxy = client.get("/api/map", headers=first).json()["galaxy"]
    assert galaxy["blocks"] == 12
    assert galaxy["shown"] == 12
    player_id = client.get("/api/me", headers=first).json()["player"]["id"]
    marked = client.post(f"/api/admin/players/{player_id}/team", json={"team": True}, headers=ADMIN)
    assert marked.status_code == 200, marked.text
    after = {row["code"]: row["builders"] for row in client.get("/api/map", headers=second).json()["world"]}
    assert after == {"JP": 1}
    cleared = client.post(
        "/api/map/country",
        json={"country": "", "idempotencyKey": "country-clear-01"},
        headers=second,
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["country"] is None
    assert cleared.json()["map"]["world"] == []
    assert client.get("/api/me", headers=second).json()["player"]["countryCode"] is None

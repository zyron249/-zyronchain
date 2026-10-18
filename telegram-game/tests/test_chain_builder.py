"""Chain Builder: the server scores drop order, replays, and the daily cap."""

import shutil
import subprocess
from datetime import timedelta

from tests.test_economy_and_auth import sign_init
from zyron_node.chain_builder import DAILY_CAP, POINTS_PER_BLOCK, prefix_correct, sequence_for

NOW = __import__("datetime").datetime(2026, 10, 4, 15, 0, tzinfo=__import__("datetime").timezone.utc)


def auth(user_id, when=NOW):
    return {
        "Authorization": "tma " + sign_init(user_id, int(when.timestamp())),
        "X-Test-Now": when.isoformat(),
    }


def test_chain_module_and_shell():
    result = subprocess.run(["node", "tests/chain.test.js"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert shutil.which("node")
    assert prefix_correct(("blue", "gold", "ice"), ["blue", "gold", "void"]) == 2


def test_perfect_stack_is_scored_on_the_server(client):
    headers = auth(5501)
    me = client.get("/api/me", headers=headers).json()["player"]
    before = me["points"]
    started = client.post("/api/chain/start", json={"idempotencyKey": "chain-start-0001"}, headers=headers)
    assert started.status_code == 200, started.text
    body = started.json()
    assert body["sequence"] == list(sequence_for(me["id"], NOW.date(), 1))
    assert len(body["sequence"]) == 5
    assert "score" not in body
    replay = client.post("/api/chain/start", json={"idempotencyKey": "chain-start-0001"}, headers=headers)
    assert replay.json()["replayed"] is True
    assert replay.json()["attempt"] == 1
    too_fast = client.post(
        "/api/chain/finish",
        json={"idempotencyKey": "chain-fin-fast-1", "attempt": 1, "placed": body["sequence"], "score": 9999},
        headers=auth(5501, NOW + timedelta(seconds=1)),
    )
    assert too_fast.status_code == 429
    assert too_fast.json()["error"]["code"] == "chain_too_fast"
    finished = client.post(
        "/api/chain/finish",
        json={"idempotencyKey": "chain-fin-good-01", "attempt": 1, "placed": body["sequence"], "score": 9999},
        headers=auth(5501, NOW + timedelta(seconds=3)),
    )
    assert finished.status_code == 200, finished.text
    assert finished.json()["points"] == 5 * POINTS_PER_BLOCK
    assert finished.json()["correct"] == 5
    assert finished.json()["playerPoints"] == before + 5 * POINTS_PER_BLOCK
    again = client.post(
        "/api/chain/finish",
        json={"idempotencyKey": "chain-fin-good-01", "attempt": 1, "placed": ["void"] * 5, "score": 9999},
        headers=auth(5501, NOW + timedelta(seconds=4)),
    )
    assert again.json()["replayed"] is True
    assert again.json()["points"] == 5 * POINTS_PER_BLOCK
    settled = client.post(
        "/api/chain/finish",
        json={"idempotencyKey": "chain-fin-again-1", "attempt": 1, "placed": body["sequence"]},
        headers=auth(5501, NOW + timedelta(seconds=5)),
    )
    assert settled.json()["alreadySettled"] is True
    assert client.get("/api/me", headers=auth(5501, NOW + timedelta(seconds=5))).json()["player"]["points"] == before + 20


def test_wrong_prefix_earns_less_and_the_day_is_capped(client):
    headers = auth(5502)
    player_id = client.get("/api/me", headers=headers).json()["player"]["id"]
    started = client.post("/api/chain/start", json={"idempotencyKey": "chain-start-0002"}, headers=headers).json()
    placed = [started["sequence"][0], started["sequence"][1], "void" if started["sequence"][2] != "void" else "gold"]
    if placed[2] == started["sequence"][2]:
        placed[2] = "blue" if started["sequence"][2] != "blue" else "chrome"
    partial = client.post(
        "/api/chain/finish",
        json={"idempotencyKey": "chain-fin-part-01", "attempt": 1, "placed": placed},
        headers=auth(5502, NOW + timedelta(seconds=3)),
    )
    assert partial.status_code == 200, partial.text
    assert partial.json()["correct"] == 2
    assert partial.json()["points"] == 2 * POINTS_PER_BLOCK
    # Two perfect runs fill the 40 point cap. This player already earned 8, so one perfect (20) and
    # another perfect is cut to the remaining 12, and a further start is refused.
    for index, key in ((2, "chain-start-0003"), (3, "chain-start-0004")):
        nxt = client.post("/api/chain/start", json={"idempotencyKey": key}, headers=auth(5502, NOW + timedelta(seconds=10 * index)))
        assert nxt.status_code == 200, nxt.text
        done = client.post(
            "/api/chain/finish",
            json={"idempotencyKey": "chain-fin-cap-" + str(index), "attempt": nxt.json()["attempt"], "placed": nxt.json()["sequence"]},
            headers=auth(5502, NOW + timedelta(seconds=10 * index + 3)),
        )
        assert done.status_code == 200, done.text
    view = client.get("/api/chain", headers=auth(5502, NOW + timedelta(seconds=40))).json()
    assert view["daily"]["used"] == DAILY_CAP
    assert view["daily"]["remaining"] == 0
    blocked = client.post(
        "/api/chain/start",
        json={"idempotencyKey": "chain-start-0005"},
        headers=auth(5502, NOW + timedelta(seconds=50)),
    )
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "chain_cap"
    missing = client.post(
        "/api/chain/finish",
        json={"idempotencyKey": "chain-fin-missing1", "attempt": 9, "placed": ["blue"]},
        headers=auth(5503, NOW + timedelta(seconds=3)),
    )
    assert missing.status_code == 404
    unknown = client.post("/api/chain/start", json={"idempotencyKey": "chain-start-0006"}, headers=auth(5503))
    assert unknown.status_code == 200
    bad = client.post(
        "/api/chain/finish",
        json={"idempotencyKey": "chain-fin-bad-0001", "attempt": 1, "placed": ["nope"]},
        headers=auth(5503, NOW + timedelta(seconds=3)),
    )
    assert bad.status_code == 400
    assert sequence_for(player_id, NOW.date(), 1)

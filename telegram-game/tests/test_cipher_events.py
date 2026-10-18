"""Daily cipher and shared network events. The server owns the word, the damage, and the points."""

import subprocess
from datetime import datetime, timedelta, timezone

from tests.test_community import FakeTelegram
from tests.test_economy_and_auth import sign_init
from zyron_node import community
from zyron_node.cipher import REWARD, hint_text, word_for
from zyron_node.events import damage_for

QUIET = datetime(2026, 10, 18, 15, 0, tzinfo=timezone.utc)
STORM = datetime(2026, 10, 18, 18, 30, tzinfo=timezone.utc)
BOSS = datetime(2026, 10, 18, 21, 30, tzinfo=timezone.utc)
CIPHER = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)


def auth(user_id, when):
    return {
        "Authorization": "tma " + sign_init(user_id, int(when.timestamp())),
        "X-Test-Now": when.isoformat(),
    }


def test_events_module():
    result = subprocess.run(["node", "tests/events.test.js"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "events ok" in result.stdout


def test_hint_never_contains_the_answer(client):
    day = CIPHER.date()
    word = word_for(day)
    text = hint_text(day)
    assert word not in text
    assert "ZYN" in text
    tg = FakeTelegram()
    settings = client.app.state.settings
    pool = client.app.state.pool
    posted = community.post_cipher_hint(pool, settings, CIPHER, tg)
    assert posted["posted"] is True
    sent = tg.of("sendMessage")[0]["text"]
    assert word not in sent
    assert "cipher" in sent.lower()
    again = community.post_cipher_hint(pool, settings, CIPHER + timedelta(hours=1), tg)
    assert again["reason"] == "already_done"
    assert len(tg.of("sendMessage")) == 1


def test_cipher_is_checked_on_the_server(client):
    headers = auth(6101, CIPHER)
    view = client.get("/api/cipher", headers=headers)
    assert view.status_code == 200, view.text
    body = view.json()
    word = word_for(CIPHER.date())
    assert word not in view.text
    assert "word" not in body
    assert body["attemptsMax"] == 8
    assert body["solved"] is False
    wrong = client.post(
        "/api/cipher/answer",
        json={"guess": "wrong", "idempotencyKey": "cipher-wrong-01"},
        headers=headers,
    )
    assert wrong.status_code == 200, wrong.text
    assert wrong.json()["correct"] is False
    assert wrong.json()["points"] == 0
    repeat = client.post(
        "/api/cipher/answer",
        json={"guess": "wrong", "idempotencyKey": "cipher-wrong-02"},
        headers=headers,
    )
    assert repeat.status_code == 409
    assert repeat.json()["error"]["code"] == "repeat_guess"
    before = client.get("/api/me", headers=headers).json()["player"]["points"]
    solved = client.post(
        "/api/cipher/answer",
        json={"guess": word.lower(), "idempotencyKey": "cipher-solve-01"},
        headers=headers,
    )
    assert solved.status_code == 200, solved.text
    assert solved.json()["correct"] is True
    assert solved.json()["points"] == REWARD
    assert solved.json()["playerPoints"] == before + REWARD
    replay = client.post(
        "/api/cipher/answer",
        json={"guess": word, "idempotencyKey": "cipher-solve-01"},
        headers=headers,
    )
    assert replay.json()["replayed"] is True
    assert replay.json()["playerPoints"] == before + REWARD
    extra = client.post(
        "/api/cipher/answer",
        json={"guess": "other", "idempotencyKey": "cipher-solve-02"},
        headers=headers,
    )
    assert extra.status_code == 200
    assert extra.json()["alreadySolved"] is True
    assert extra.json()["points"] == 0
    assert client.get("/api/me", headers=headers).json()["player"]["points"] == before + REWARD


def test_cipher_guess_cap(client):
    headers = auth(6102, CIPHER)
    word = word_for(CIPHER.date())
    for n in range(8):
        guess = "NOPE" + "ABCDEFGH"[n]
        assert guess != word
        res = client.post(
            "/api/cipher/answer",
            json={"guess": guess, "idempotencyKey": f"cipher-cap-{n:02d}"},
            headers=headers,
        )
        assert res.status_code == 200, res.text
        assert res.json()["points"] == 0
    blocked = client.post(
        "/api/cipher/answer",
        json={"guess": "LATER", "idempotencyKey": "cipher-cap-09"},
        headers=headers,
    )
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "cipher_limited"


def test_no_event_outside_the_window(client):
    headers = auth(6103, QUIET)
    assert client.get("/api/me", headers=headers).status_code == 200
    status = client.get("/api/events", headers=headers)
    assert status.status_code == 200
    assert status.json()["active"] is None
    strike = client.post("/api/events/strike", json={"idempotencyKey": "strike-quiet-01"}, headers=headers)
    assert strike.status_code == 409
    assert strike.json()["error"]["code"] == "no_event"


def test_bug_monster_shares_hp_and_caps_points(client):
    first = auth(6104, BOSS)
    second = auth(6105, BOSS)
    me = client.get("/api/me", headers=first).json()["player"]
    client.get("/api/me", headers=second)
    opened = client.get("/api/events", headers=first).json()["active"]
    assert opened["kind"] == "bug_monster"
    assert opened["hp"] == 120
    hp = opened["hp"]
    finisher = None
    paid = 0
    for n in range(6):
        res = client.post(
            "/api/events/strike",
            json={"idempotencyKey": f"boss-a-{n:02d}", "score": 9999},
            headers=first,
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["damage"] == damage_for(me["id"], body["active"]["key"], n + 1)
        assert body["damage"] != 9999
        assert body["active"]["hp"] <= hp
        hp = body["active"]["hp"]
        paid += body["points"]
        if body["finisher"]:
            finisher = body
            break
    assert finisher is not None
    assert finisher["active"]["defeated"] is True
    assert finisher["points"] >= 12
    replay = client.post(
        "/api/events/strike",
        json={"idempotencyKey": f"boss-a-{(finisher['active']['yourStrikes'] - 1):02d}"},
        headers=first,
    )
    assert replay.json()["replayed"] is True
    assert replay.json()["active"]["hp"] == 0
    poke = client.post("/api/events/strike", json={"idempotencyKey": "boss-b-00"}, headers=second)
    assert poke.status_code == 200, poke.text
    assert poke.json()["points"] == 0
    assert poke.json()["active"]["hp"] == 0
    claim_b = client.post("/api/events/claim", json={"idempotencyKey": "boss-claim-b"}, headers=second)
    assert claim_b.status_code == 200, claim_b.text
    assert claim_b.json()["points"] == 8
    again = client.post("/api/events/claim", json={"idempotencyKey": "boss-claim-b2"}, headers=second)
    assert again.json()["alreadyClaimed"] is True
    assert again.json()["points"] == 0
    with client.app.state.pool.connection() as conn:
        conn.execute(
            """
            UPDATE network_event_strikes SET points = 0
            WHERE player_id = %s AND event_key = %s
            """,
            (me["id"], finisher["active"]["key"]),
        )
        conn.execute(
            """
            UPDATE network_event_strikes SET points = 40
            WHERE player_id = %s AND event_key = %s AND strike_no = 1
            """,
            (me["id"], finisher["active"]["key"]),
        )
    capped = client.post("/api/events/claim", json={"idempotencyKey": "boss-claim-a"}, headers=first)
    assert capped.status_code == 409
    assert capped.json()["error"]["code"] == "event_capped"
    assert paid <= 40


def test_block_storm_progress_is_server_side(client):
    headers = auth(6106, STORM)
    status = client.get("/api/events", headers=headers)
    assert status.json()["active"]["kind"] == "block_storm"
    seen = 0
    for n in range(5):
        res = client.post(
            "/api/events/strike",
            json={"idempotencyKey": f"storm-{n:02d}", "score": 1},
            headers=headers,
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["damage"] == 8
        seen = body["active"]["progress"]
    assert seen == 40
    assert body["finisher"] is True
    claim = client.post("/api/events/claim", json={"idempotencyKey": "storm-claim-01"}, headers=headers)
    assert claim.status_code == 200, claim.text
    assert claim.json()["points"] == 8
    early = client.post(
        "/api/events/claim",
        json={"idempotencyKey": "storm-claim-early"},
        headers=auth(6107, STORM),
    )
    assert early.status_code == 409
    assert early.json()["error"]["code"] == "no_strike"

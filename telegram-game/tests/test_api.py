import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tests.test_economy_and_auth import sign_init
from zyron_node.bot import menu_button_payload, parse_command, reply_for
from zyron_node.game import run_cycle

NOW = datetime(2026, 9, 22, 15, 0, tzinfo=timezone.utc)


def auth(user_id, when=None, start=None):
    headers = {"Authorization": "tma " + sign_init(user_id, int((when or NOW).timestamp()), start_param=start)}
    headers["X-Test-Now"] = (when or NOW).isoformat()
    return headers


def test_health_and_meta(client):
    assert client.get("/healthz").json()["ok"] is True
    assert client.get("/readyz").status_code == 200
    meta = client.get("/api/meta").json()
    assert meta["name"] == "ZYRON NODE"
    assert "no conversion rate" in meta["pointsNotice"]
    assert meta["devAuth"] is False
    assert client.post("/tx").status_code == 404


def test_rejects_missing_and_bad_init_data(client):
    assert client.get("/api/me").status_code == 401
    bad = auth(7)
    bad["Authorization"] = bad["Authorization"][:-4] + "dead"
    assert client.get("/api/me", headers=bad).status_code == 401


def test_cycle_is_idempotent_and_rate_limited(client):
    headers = auth(11)
    me = client.get("/api/me", headers=headers)
    assert me.status_code == 200
    body = me.json()["player"]
    assert body["level"] == 1
    assert body["points"] == 0
    assert body["energy"]["current"] == 100
    assert body["networkPower"] >= 10
    first = client.post("/api/cycle", json={"idempotencyKey": "cycle-key-0001"}, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["gained"] == 1
    assert first.json()["replayed"] is False
    assert "first_cycle" in first.json()["achievementsUnlocked"]
    replay = client.post("/api/cycle", json={"idempotencyKey": "cycle-key-0001"}, headers=headers)
    assert replay.json()["replayed"] is True
    assert replay.json()["points"] == first.json()["points"]
    too_fast = client.post("/api/cycle", json={"idempotencyKey": "cycle-key-0002"}, headers=headers)
    assert too_fast.status_code == 429


def test_parallel_same_idempotency_key_grants_once(client):
    headers = auth(12)
    player_id = client.get("/api/me", headers=headers).json()["player"]["id"]
    pool = client.app.state.pool
    barrier = threading.Barrier(2)
    results = []

    def worker():
        barrier.wait()
        try:
            results.append(
                run_cycle(pool, player_id, "parallel-key-01", NOW, min_interval_ms=800, min_cycles=2, min_age=0)
            )
        except Exception as exc:  # noqa: BLE001 — the test records either outcome
            results.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    payloads = [item for item in results if isinstance(item, dict)]
    assert len(payloads) == 2
    assert sum(1 for item in payloads if not item["replayed"]) == 1
    assert payloads[0]["points"] == payloads[1]["points"]


def test_upgrade_streak_and_leaderboard(client):
    headers = auth(21, NOW)
    for index in range(25):
        when = NOW + timedelta(seconds=index * 2)
        response = client.post(
            "/api/cycle",
            json={"idempotencyKey": f"cycle-key-{index:04d}"},
            headers=auth(21, when),
        )
        assert response.status_code == 200, response.text
    bought = client.post(
        "/api/upgrade",
        json={"module": "cpu", "idempotencyKey": "upgrade-key-01"},
        headers=auth(21, NOW + timedelta(minutes=5)),
    )
    assert bought.status_code == 200, bought.text
    assert bought.json()["level"] == 1
    assert bought.json()["spent"] == 20
    poor = client.post(
        "/api/upgrade",
        json={"module": "cpu", "idempotencyKey": "upgrade-key-poor"},
        headers=auth(22, NOW),
    )
    assert poor.status_code == 409
    claimed = client.post("/api/streak/claim", headers=headers)
    assert claimed.status_code == 200
    assert claimed.json()["gained"] == 10
    again = client.post("/api/streak/claim", headers=headers)
    assert again.json()["replayed"] is True
    assert again.json()["points"] == claimed.json()["points"]
    nxt = client.post("/api/streak/claim", headers=auth(21, NOW + timedelta(days=1)))
    assert nxt.json()["streak"] == 2
    assert nxt.json()["gained"] == 15
    reset = client.post("/api/streak/claim", headers=auth(21, NOW + timedelta(days=4)))
    assert reset.json()["streak"] == 1
    quests = client.post("/api/quests/sync", headers=auth(21, NOW + timedelta(days=4)))
    assert quests.status_code == 200
    daily = {item["id"]: item for item in quests.json()["quests"]}
    assert daily["daily_login"]["claimed"] is True
    assert daily["once_upgrade"]["claimed"] is True
    second = client.post("/api/quests/sync", headers=auth(21, NOW + timedelta(days=4)))
    assert second.json()["points"] == quests.json()["points"]
    board = client.get("/api/leaderboard?board=alltime", headers=headers)
    assert board.status_code == 200
    assert board.json()["me"]["score"] > 0
    assert board.json()["entries"][0]["you"] is True
    home = client.get("/", headers=headers)
    assert home.status_code == 200
    assert "ZYRON NODE" in home.text


def test_referral_qualifies_once(client):
    referrer = client.get("/api/me", headers=auth(31)).json()["player"]
    code = referrer["referral"]["code"]
    joined = client.get("/api/me", headers=auth(32, start="ref_" + code))
    assert joined.status_code == 200
    for index in range(2):
        response = client.post(
            "/api/cycle",
            json={"idempotencyKey": f"ref-cycle-{index}"},
            headers=auth(32, NOW + timedelta(seconds=5 * (index + 1)), start="ref_" + code),
        )
        assert response.status_code == 200, response.text
    assert response.json()["referralQualified"] is True
    referrer_after = client.get("/api/me", headers=auth(31, NOW + timedelta(minutes=1))).json()["player"]
    assert referrer_after["points"] == 100
    assert referrer_after["referral"]["qualified"] == 1
    extra = client.post(
        "/api/cycle",
        json={"idempotencyKey": "ref-cycle-extra"},
        headers=auth(32, NOW + timedelta(seconds=30)),
    )
    assert extra.json()["referralQualified"] is False


def test_wallet_and_activity_and_snapshot(client):
    headers = auth(41)
    address = "ZYN" + "cd" * 20
    linked = client.post(
        "/api/wallet/link",
        json={"address": address, "idempotencyKey": "wallet-key-01"},
        headers=headers,
    )
    assert linked.status_code == 200, linked.text
    assert linked.json()["address"] == address
    bad = client.post(
        "/api/wallet/link",
        json={"address": "ZYN" + "CD" * 20, "idempotencyKey": "wallet-key-02"},
        headers=headers,
    )
    assert bad.status_code == 400
    other = client.post(
        "/api/wallet/link",
        json={"address": address, "idempotencyKey": "wallet-key-03"},
        headers=auth(42),
    )
    assert other.status_code == 409
    offline = client.get("/api/activity", headers=headers)
    assert offline.json()["configured"] is False
    calls = []

    def fetch(url, headers, timeout):
        calls.append(url)
        if url.endswith("/status"):
            body = {"chainId": "zyron-local-test", "genesisHash": "gg", "height": 2, "tipHash": "hh"}
        elif url.endswith("/protocol"):
            body = {"currentVersion": 1, "nextVersion": 1}
        elif url.endswith("/healthz"):
            body = {"ok": True, "height": 2}
        elif "/blocks?" in url:
            body = {"blocks": [{"hash": "1234567890abcdef", "header": {"height": 2, "timestampMs": 5}, "transactions": []}]}
        elif "/balance/" in url:
            body = {"balanceAtoms": 250_000_000}
        else:
            body = {"nonce": 1}
        return 200, json.dumps(body), {"x-zyron-rpc-version": "1"}

    client.app.state.chain.base_url = "http://127.0.0.1:9137"
    client.app.state.chain.fetch = fetch
    panel = client.get("/api/activity", headers=headers)
    assert panel.status_code == 200, panel.text
    assert panel.json()["reachable"] is True
    assert panel.json()["wallet"]["balanceZyn"] == "2.50000000"
    assert calls and all("http://127.0.0.1:9137/" in url for url in calls)
    quests = client.post("/api/quests/sync", headers=headers).json()
    by_id = {item["id"]: item for item in quests["quests"]}
    assert by_id["once_wallet"]["claimed"] is True
    assert by_id["once_chain_wallet"]["claimed"] is True
    assert by_id["daily_chain"]["claimed"] is True
    admin = {"Authorization": "Bearer test-admin-token", "X-Test-Now": NOW.isoformat()}
    assert client.get("/api/admin/overview").status_code == 401
    snapshot = client.post("/api/admin/season/snapshot", headers=admin)
    assert snapshot.status_code == 200, snapshot.text
    body = snapshot.json()
    assert body["conversionRate"] is None
    assert body["automaticPayout"] is False
    assert "telegramId" not in json.dumps(body)
    assert "private" not in json.dumps(body).lower()
    banned = client.post("/api/admin/players/1/ban", json={"banned": True}, headers=admin)
    assert banned.status_code == 200
    denied = client.post("/api/cycle", json={"idempotencyKey": "after-ban-0001"}, headers=auth(41, NOW + timedelta(minutes=2)))
    assert denied.status_code == 403
    closed = client.post("/api/admin/season/close", headers=admin)
    assert closed.json()["payout"] is False


def test_bot_commands_do_not_touch_groups():
    assert parse_command("/start@ZyronNodeBot ref_ABCDEFGH") == ("start", "ref_ABCDEFGH")
    reply = reply_for("play", "", None, "https://game.example/app")
    assert reply["reply_markup"]["inline_keyboard"][0][0]["text"] == "Play Zyron"
    assert "no conversion rate" in reply["text"]
    menu = menu_button_payload("https://game.example/app")
    assert menu["menu_button"]["text"] == "Play Zyron"
    help_text = reply_for("help", "", None, "")["text"]
    assert "private key" in help_text
    source = Path("src/zyron_node/bot.py").read_text(encoding="utf-8")
    for forbidden in ("banChatMember", "promoteChatMember", "setChatPermissions", "deleteMessage"):
        assert forbidden not in source


def test_service_does_not_touch_consensus_or_keys():
    root = Path("src")
    text = "\n".join(path.read_text(encoding="utf-8") for path in root.rglob("*.py"))
    assert "BEGIN PRIVATE KEY" not in text
    assert "POINTS_PER_ZYRUM" not in text
    assert "zyron.blockchain" not in text
    assert "from l1" not in text
    frontend = Path("frontend/app.js").read_text(encoding="utf-8")
    for label in ("Level", "Zyron Points", "Energy", "Network Power", "Rank"):
        assert label in frontend
    assert "seed phrase" in frontend
    assert "Run node cycle" in frontend

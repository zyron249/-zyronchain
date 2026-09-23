import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tests.test_economy_and_auth import sign_init
from zyron_node.bot import menu_button_payload, parse_command, reply_for
from zyron_node.buildinfo import CLIENT_BUILD, SHELL_ID
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
    assert meta["shell"] == SHELL_ID
    assert meta["clientBuild"] == CLIENT_BUILD
    assert "no conversion rate" in meta["pointsNotice"]
    assert meta["devAuth"] is False
    assert meta["cycleMinIntervalMs"] == 800
    assert meta["autoCyclePaceMs"] >= 1500
    assert meta["rules"]["referralReferrer"] == 100
    assert meta["rules"]["levelChestStep"] == 10
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
    assert body["energy"]["nextInSeconds"] == 0
    assert body["energy"]["nextAt"] is None
    assert body["networkPower"] >= 10
    first = client.post("/api/cycle", json={"idempotencyKey": "cycle-key-0001"}, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["gained"] == 1
    assert first.json()["energySpent"] == 1
    assert first.json()["replayed"] is False
    assert first.json()["energy"]["current"] == 99
    assert first.json()["energy"]["nextInSeconds"] > 0
    assert first.json()["energy"]["nextAt"]
    assert "first_cycle" in first.json()["achievementsUnlocked"]
    replay = client.post("/api/cycle", json={"idempotencyKey": "cycle-key-0001"}, headers=headers)
    assert replay.json()["replayed"] is True
    assert replay.json()["points"] == first.json()["points"]
    too_fast = client.post("/api/cycle", json={"idempotencyKey": "cycle-key-0002"}, headers=headers)
    assert too_fast.status_code == 429
    assert "settling" not in too_fast.json()["error"]["message"].lower()
    assert int(too_fast.headers["retry-after"]) >= 1


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


def test_supply_chests_pay_streak_and_quest_once(client):
    headers = auth(81)
    listed = client.get("/api/chests", headers=headers)
    assert listed.status_code == 200, listed.text
    ready = {item["id"]: item for item in listed.json()["ready"]}
    sealed = {item["id"]: item for item in listed.json()["sealed"]}
    assert ready["daily"]["reward"] == 10
    assert ready["daily"]["kind"] == "daily"
    assert "quest:daily_login" not in ready
    assert sealed["quest:daily_login"]["ready"] is False
    assert sealed["level:2"]["target"] == 4
    opened = client.post("/api/chests/open", json={"id": "daily"}, headers=headers)
    assert opened.status_code == 200, opened.text
    assert opened.json()["gained"] == 10
    assert opened.json()["replayed"] is False
    assert opened.json()["points"] == 10
    again = client.post("/api/chests/open", json={"id": "daily"}, headers=headers)
    assert again.json()["replayed"] is True
    assert again.json()["gained"] == 0
    assert again.json()["points"] == 10
    quests = client.get("/api/chests", headers=headers).json()
    quest_ready = {item["id"]: item for item in quests["ready"]}
    assert quest_ready["quest:daily_login"]["reward"] == 15
    claimed = client.post("/api/chests/open", json={"id": "quest:daily_login"}, headers=headers)
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["gained"] == 15
    assert claimed.json()["points"] == 25
    replay = client.post("/api/chests/open", json={"id": "daily"}, headers=headers)
    assert replay.json()["replayed"] is True
    assert replay.json()["gained"] == 0
    assert replay.json()["points"] == 25
    synced = client.post("/api/quests/sync", headers=headers)
    assert synced.json()["points"] == 25
    sealed_open = client.post("/api/chests/open", json={"id": "quest:daily_cycles"}, headers=headers)
    assert sealed_open.status_code == 409
    assert client.post("/api/chests/open", json={"id": "loot"}, headers=headers).status_code == 422
    assert client.post("/api/chests/open", json={"id": "quest:not_real"}, headers=headers).status_code == 400
    assert client.post("/api/chests/open", json={"id": "level:2"}, headers=headers).status_code == 409


def test_cycles_leave_quest_chest_for_the_player_to_open(client):
    for index in range(25):
        when = NOW + timedelta(seconds=index * 2)
        response = client.post(
            "/api/cycle",
            json={"idempotencyKey": f"chest-cycle-{index:04d}"},
            headers=auth(61, when),
        )
        assert response.status_code == 200, response.text
        assert "daily_cycles" not in response.json()["questsCompleted"]
    when = NOW + timedelta(seconds=80)
    headers = auth(61, when)
    quests = client.get("/api/quests", headers=headers).json()
    daily = {item["id"]: item for item in quests["quests"]}
    assert daily["daily_cycles"]["complete"] is True
    assert daily["daily_cycles"]["claimed"] is False
    before = client.get("/api/me", headers=headers).json()["player"]["points"]
    opened = client.post("/api/chests/open", json={"id": "quest:daily_cycles"}, headers=headers)
    assert opened.status_code == 200, opened.text
    assert opened.json()["gained"] == 40
    assert opened.json()["replayed"] is False
    after = client.get("/api/me", headers=auth(61, NOW + timedelta(seconds=90))).json()["player"]["points"]
    assert after == before + 40
    second = client.post("/api/chests/open", json={"id": "quest:daily_cycles"}, headers=auth(61, NOW + timedelta(seconds=100)))
    assert second.json()["replayed"] is True
    assert second.json()["gained"] == 0
    assert second.json()["points"] == after


def test_level_chest_pays_once_after_the_node_levels(client):
    headers = auth(71)
    player_id = client.get("/api/me", headers=headers).json()["player"]["id"]
    assert client.post("/api/chests/open", json={"id": "level:2"}, headers=headers).status_code == 409
    with client.app.state.pool.connection() as conn:
        with conn.transaction():
            conn.execute(
                "UPDATE player_upgrades SET level = 4 WHERE player_id = %s AND module = 'cpu'",
                (player_id,),
            )
    listed = client.get("/api/chests", headers=headers).json()
    ready = {item["id"]: item for item in listed["ready"]}
    assert ready["level:2"]["reward"] == 10
    opened = client.post("/api/chests/open", json={"id": "level:2"}, headers=headers)
    assert opened.status_code == 200, opened.text
    assert opened.json()["gained"] == 10
    assert opened.json()["replayed"] is False
    again = client.post("/api/chests/open", json={"id": "level:2"}, headers=headers)
    assert again.json()["replayed"] is True
    assert again.json()["gained"] == 0
    assert again.json()["points"] == opened.json()["points"]


def test_bot_commands_do_not_touch_groups():
    assert parse_command("/start@ZyronNodeBot ref_ABCDEFGH") == ("start", "ref_ABCDEFGH")
    reply = reply_for("play", "", None, "https://game.example/app")
    assert reply["reply_markup"]["inline_keyboard"][0][0]["text"] == "Play Zyron"
    assert reply["reply_markup"]["inline_keyboard"][0][0]["web_app"]["url"].endswith("?v=" + CLIENT_BUILD)
    assert "no conversion rate" in reply["text"]
    menu = menu_button_payload("https://game.example/app?ref=keep")
    assert menu["menu_button"]["text"] == "Play Zyron"
    menu_url = menu["menu_button"]["web_app"]["url"]
    assert "ref=keep" in menu_url
    assert "v=" + CLIENT_BUILD in menu_url
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
    assert "Start node" in frontend
    assert SHELL_ID in frontend
    assert "Recent cycles" in frontend


def test_shell_assets_are_versioned_and_stale_js_does_not_boot(client):
    home = client.get("/")
    assert home.status_code == 200
    assert "no-store" in home.headers["cache-control"]
    assert f"/assets/app.js?v={CLIENT_BUILD}" in home.text
    assert f"/assets/styles.css?v={CLIENT_BUILD}" in home.text
    assert f"/assets/boot.js?v={CLIENT_BUILD}" in home.text
    assert SHELL_ID in home.text
    fresh = client.get(f"/assets/app.js?v={CLIENT_BUILD}")
    assert fresh.status_code == 200
    assert "immutable" in fresh.headers["cache-control"]
    assert "Chests" in fresh.text
    assert "Intel" in fresh.text
    stale = client.get("/assets/app.js")
    assert stale.status_code == 200
    assert "no-store" in stale.headers["cache-control"]
    assert "ZYRON NODE updated" in stale.text
    assert "Quests" not in stale.text
    assert "Supply chests" not in stale.text
    old = client.get("/assets/app.js?v=old-shell")
    assert "ZYRON NODE updated" in old.text
    assert "Chests" not in old.text


def test_upgrade_preview_reports_cycle_and_energy_impact(client):
    headers = auth(81)
    view = client.get("/api/upgrades", headers=headers)
    assert view.status_code == 200, view.text
    body = view.json()
    assert body["cycleReward"] == 1
    modules = {item["id"]: item for item in body["modules"]}
    cpu = modules["cpu"]["preview"]
    assert cpu["cycleReward"] == 2
    assert cpu["cycleRewardDelta"] == 1
    assert cpu["energyMaxDelta"] == 0
    energy = modules["energy"]["preview"]
    assert energy["energyMaxDelta"] == 20
    assert energy["regenSecondsDelta"] == -10
    assert energy["cycleRewardDelta"] == 0
    network = modules["network"]["preview"]
    assert network["networkPowerDelta"] == 8


def test_leaderboard_empty_and_neighbors_are_real_players(client):
    headers = auth(91)
    empty = client.get("/api/leaderboard?board=daily", headers=headers)
    assert empty.status_code == 200, empty.text
    alone = empty.json()
    assert alone["population"] == 0
    assert alone["entries"] == []
    assert alone["neighbors"] == []
    assert alone["me"]["score"] == 0
    assert alone["me"]["onBoard"] is False
    assert alone["me"]["displayName"]
    first = client.post("/api/cycle", json={"idempotencyKey": "board-cycle-0001"}, headers=headers)
    assert first.status_code == 200, first.text
    solo = client.get("/api/leaderboard?board=alltime", headers=headers).json()
    assert solo["population"] == 1
    assert len(solo["entries"]) == 1
    assert solo["entries"][0]["you"] is True
    assert solo["neighbors"][0]["you"] is True
    assert solo["neighbors"][0]["playerId"] == solo["entries"][0]["playerId"]
    assert solo["me"]["onBoard"] is True
    assert solo["me"]["rank"] == 1
    for index in range(3):
        response = client.post(
            "/api/cycle",
            json={"idempotencyKey": f"board-other-{index}"},
            headers=auth(92, NOW + timedelta(seconds=2 * (index + 1))),
        )
        assert response.status_code == 200, response.text
    board = client.get("/api/leaderboard?board=alltime", headers=headers).json()
    assert board["population"] == 2
    ids = {entry["playerId"] for entry in board["neighbors"]}
    assert ids == {entry["playerId"] for entry in board["entries"]}
    assert all(entry["displayName"] for entry in board["neighbors"])
    assert sum(1 for entry in board["neighbors"] if entry["you"]) == 1

import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from tests.test_economy_and_auth import sign_init
from zyron_node import reminders
from zyron_node.bot import COMMANDS, handle_update
from zyron_node.db import split_sql
from zyron_node.economy import empty_levels
from zyron_node.telegram_api import TelegramError

NOW = datetime(2026, 9, 22, 15, 0, tzinfo=timezone.utc)
PLAY = "https://zyron249.github.io/-zyronchain/?v=test"


def auth(user_id, when=None, pm=True):
    when = when or NOW
    return {"Authorization": "tma " + sign_init(user_id, int(when.timestamp()), pm=pm), "X-Test-Now": when.isoformat()}


def player(**overrides):
    base = {
        "id": 7,
        "telegram_id": 70,
        "chat_id": 70,
        "banned": False,
        "reminders_opt_out": False,
        "reminders_unreachable_at": None,
        "energy": 40,
        "energy_updated_at": NOW - timedelta(hours=10),
        "last_seen_at": NOW - timedelta(hours=10),
        "last_cycle_at": NOW - timedelta(hours=10),
        "streak_last_date": NOW.date(),
        "energy_reminded_at": None,
        "chest_reminded_at": None,
        "last_reminded_at": None,
    }
    base.update(overrides)
    return base


class FakeTelegram:
    def __init__(self, fail=None):
        self.calls = []
        self.fail = list(fail or [])

    def __call__(self, token, method, payload, timeout=15):
        self.calls.append((method, payload))
        if self.fail:
            error = self.fail.pop(0)
            if error:
                raise error
        if method == "getChatAdministrators":
            return {"ok": True, "result": [{"status": "creator", "user": {"id": 501}}]}
        return {"ok": True, "result": {"message_id": len(self.calls)}}

    def sends(self):
        return [payload for method, payload in self.calls if method == "sendMessage"]


def test_energy_full_time_follows_the_regen_model():
    levels = empty_levels()
    assert reminders.energy_full_at(100, NOW, levels) == NOW
    assert reminders.energy_full_at(98, NOW, levels) == NOW + timedelta(seconds=600)
    upgraded = dict(levels, energy=3)  # cap 160, one point every 270 s
    assert reminders.energy_full_at(150, NOW, upgraded) == NOW + timedelta(seconds=10 * 270)


def test_energy_trigger_fires_once_per_refill_and_skips_active_players():
    levels = empty_levels()
    full_at = NOW - timedelta(minutes=1)
    spent = dict(energy=100 - 10, energy_updated_at=full_at - timedelta(seconds=3000),
                 last_seen_at=NOW - timedelta(hours=1), last_cycle_at=full_at - timedelta(seconds=3000))
    assert reminders.decide(player(**spent), levels, NOW).kind == "energy"
    assert reminders.decide(player(**spent, energy_reminded_at=full_at), levels, NOW).reason == "energy_sent"
    older = full_at - timedelta(hours=3)
    assert reminders.decide(player(**spent, energy_reminded_at=older), levels, NOW).kind == "energy"
    still_regen = dict(spent, energy_updated_at=NOW - timedelta(seconds=100))
    assert reminders.decide(player(**still_regen), levels, NOW).reason == "energy_regen"
    active = dict(spent, last_seen_at=NOW - timedelta(minutes=4))
    assert reminders.decide(player(**active), levels, NOW).reason == "active"
    # Full at NOW-10m, then they opened the app at NOW-6m: they saw it, so no DM this refill.
    seen = dict(spent, energy_updated_at=NOW - timedelta(minutes=10) - timedelta(seconds=3000),
                last_seen_at=NOW - timedelta(minutes=6))
    assert reminders.decide(player(**seen), levels, NOW).reason == "energy_seen"
    for flag, reason in (
        ({"reminders_opt_out": True}, "opted_out"),
        ({"reminders_unreachable_at": NOW}, "unreachable"),
        ({"chat_id": None}, "no_chat"),
        ({"banned": True}, "banned"),
    ):
        assert reminders.decide(player(**spent, **flag), levels, NOW).reason == reason


def test_energy_trigger_has_no_time_window():
    levels = empty_levels()
    for hour in (0, 3, 9, 23):
        now = NOW.replace(hour=hour)
        row = player(energy=99, energy_updated_at=now - timedelta(seconds=301),
                     last_seen_at=now - timedelta(hours=2), last_cycle_at=now - timedelta(hours=2))
        assert reminders.decide(row, levels, now).kind == "energy"


def test_daily_chest_is_secondary_and_capped_at_once_per_day():
    levels = empty_levels()
    idle = dict(last_seen_at=NOW - timedelta(hours=13), last_cycle_at=NOW - timedelta(hours=13),
                energy_updated_at=NOW - timedelta(hours=13), energy=100, streak_last_date=NOW.date() - timedelta(days=1))
    assert reminders.decide(player(**idle), levels, NOW).kind == "chest"
    assert reminders.decide(player(**idle, chest_reminded_at=NOW - timedelta(hours=23)), levels, NOW).kind is None
    assert reminders.decide(player(**idle, chest_reminded_at=NOW - timedelta(hours=25)), levels, NOW).kind == "chest"
    assert reminders.decide(player(**dict(idle, streak_last_date=NOW.date())), levels, NOW).kind is None
    assert reminders.decide(player(**idle), levels, NOW.replace(hour=3)).kind is None
    lapsed = dict(idle, last_seen_at=NOW - timedelta(days=8), last_cycle_at=NOW - timedelta(days=8),
                  energy_updated_at=NOW - timedelta(days=8))
    assert reminders.decide(player(**lapsed), levels, NOW).kind is None
    # energy wins when both are due
    both = dict(idle, energy=99, energy_updated_at=NOW - timedelta(seconds=400))
    assert reminders.decide(player(**both), levels, NOW).kind == "energy"


def test_reminder_payload_has_play_and_opt_out_buttons_and_honest_copy():
    for kind in ("energy", "chest"):
        message = reminders.reminder_message(kind, 3, NOW, PLAY)
        rows = message["reply_markup"]["inline_keyboard"]
        assert rows[0][0] == {"text": "Play Zyron", "web_app": {"url": PLAY}}
        assert rows[-1][0] == {"text": "Turn off reminders", "callback_data": reminders.CALLBACK_OFF}
        assert "off-chain" in message["text"]
    copy = " ".join(reminders.ENERGY_TEXTS + reminders.CHEST_TEXTS + (reminders.FOOTER,)).lower()
    for banned in ("price", "invest", "profit", "zyn ", "airdrop", "guarantee"):
        assert banned not in copy
    assert not re.search(r"\bmin(er|ers|ing)\b", copy)
    no_https = reminders.reminder_message("energy", 3, NOW, "http://localhost/")
    assert len(no_https["reply_markup"]["inline_keyboard"]) == 1


def _spend_energy(client, user_id):
    me = client.get("/api/me", headers=auth(user_id))
    assert me.status_code == 200, me.text
    for i in range(2):
        at = NOW + timedelta(seconds=1 + i)
        res = client.post("/api/cycle", json={"idempotencyKey": f"rem-{user_id}-{i:04d}"}, headers=auth(user_id, at))
        assert res.status_code == 200, res.text
    return int(me.json()["player"]["id"])


def _row(pool, player_id):
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM players WHERE id = %s", (player_id,)).fetchone()


def test_tick_sends_one_reminder_per_refill_cycle(client):
    pool = client.app.state.pool
    pid = _spend_energy(client, 801)
    assert _row(pool, pid)["chat_id"] == 801  # allows_write_to_pm recorded the private chat
    tg = FakeTelegram()
    sleeps = []
    early = reminders.run_tick(pool, "t", PLAY, NOW + timedelta(minutes=4), tg, sleeps.append)
    assert early["sent"] == {"energy": 0, "chest": 0}
    later = NOW + timedelta(minutes=20)
    result = reminders.run_tick(pool, "t", PLAY, later, tg, sleeps.append)
    assert result["sent"]["energy"] == 1
    assert tg.sends()[0]["chat_id"] == 801
    again = reminders.run_tick(pool, "t", PLAY, later + timedelta(minutes=2), tg, sleeps.append)
    assert again["sent"]["energy"] == 0 and len(tg.sends()) == 1
    # Spend again, wait for the refill: exactly one more.
    spend_at = later + timedelta(minutes=30)
    res = client.post("/api/cycle", json={"idempotencyKey": "rem-801-again"}, headers=auth(801, spend_at))
    assert res.status_code == 200, res.text
    assert reminders.run_tick(pool, "t", PLAY, spend_at + timedelta(minutes=3), tg, sleeps.append)["sent"]["energy"] == 0
    assert reminders.run_tick(pool, "t", PLAY, spend_at + timedelta(minutes=12), tg, sleeps.append)["sent"]["energy"] == 1
    assert len(tg.sends()) == 2
    with pool.connection() as conn:
        job = conn.execute("SELECT * FROM bot_jobs WHERE name = 'reminders'").fetchone()
    assert job["last_run_at"] == spend_at + timedelta(minutes=12)


def test_players_without_pm_permission_get_nothing(client):
    pool = client.app.state.pool
    me = client.get("/api/me", headers=auth(802, pm=False))
    assert _row(pool, int(me.json()["player"]["id"]))["chat_id"] is None
    tg = FakeTelegram()
    reminders.run_tick(pool, "t", PLAY, NOW + timedelta(days=1), tg, lambda s: None)
    assert tg.sends() == []


def test_blocked_bot_marks_unreachable_and_429_waits(client):
    pool = client.app.state.pool
    blocked = _spend_energy(client, 803)
    tg = FakeTelegram(fail=[TelegramError("sendMessage", 403, "Forbidden: bot was blocked by the user")])
    later = NOW + timedelta(minutes=20)
    result = reminders.run_tick(pool, "t", PLAY, later, tg, lambda s: None)
    assert result["blocked"] == 1 and result["sent"]["energy"] == 0
    row = _row(pool, blocked)
    assert row["reminders_unreachable_at"] == later
    assert row["energy_reminded_at"] is None  # claim released
    assert reminders.run_tick(pool, "t", PLAY, later + timedelta(minutes=5), FakeTelegram(), lambda s: None)["sent"]["energy"] == 0
    reminders.record_chat(pool, 803, 803)  # they wrote to the bot again
    assert _row(pool, blocked)["reminders_unreachable_at"] is None

    _spend_energy(client, 804)
    waits = []
    tg = FakeTelegram(fail=[TelegramError("sendMessage", 429, "Too Many Requests", retry_after=7)])
    result = reminders.run_tick(pool, "t", PLAY, later + timedelta(minutes=6), tg, waits.append)
    assert 7 in waits
    assert result["sent"]["energy"] == 2  # 803 (reachable again) and 804, after the retry
    assert reminders.SEND_INTERVAL_SECONDS in waits


def test_opt_out_button_and_reminders_command(client):
    pool = client.app.state.pool
    settings = client.app.state.settings
    _spend_energy(client, 805)
    tg = FakeTelegram()
    handle_update(pool, settings, {"callback_query": {
        "id": "cb1", "from": {"id": 805}, "data": reminders.CALLBACK_OFF,
        "message": {"message_id": 9, "chat": {"id": 805, "type": "private"}},
    }}, call=tg)
    methods = [m for m, _ in tg.calls]
    assert methods[:2] == ["answerCallbackQuery", "editMessageReplyMarkup"]
    assert reminders.reminders_status(pool, 805) is False
    assert reminders.run_tick(pool, "t", PLAY, NOW + timedelta(minutes=20), FakeTelegram(), lambda s: None)["sent"]["energy"] == 0

    msg = {"message": {"text": "/reminders on", "from": {"id": 805}, "chat": {"id": 805, "type": "private"}}}
    handle_update(pool, settings, msg, call=tg)
    assert reminders.reminders_status(pool, 805) is True
    assert "Reminders are on" in tg.sends()[-1]["text"]
    msg["message"]["text"] = "/reminders off"
    handle_update(pool, settings, msg, call=tg)
    assert reminders.reminders_status(pool, 805) is False
    msg["message"]["text"] = "/reminders"
    handle_update(pool, settings, msg, call=tg)
    assert tg.sends()[-1]["text"].startswith("Reminders are off")
    assert any(c["command"] == "reminders" for c in COMMANDS)


def test_admin_dry_run_counts_and_sends_nothing(client):
    _spend_energy(client, 806)
    later = NOW + timedelta(minutes=20)
    assert client.get("/api/admin/reminders").status_code == 401
    res = client.get("/api/admin/reminders", headers={"Authorization": "Bearer test-admin-token", "X-Test-Now": later.isoformat()})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["dryRun"] is True
    assert body["due"]["energy"] == 1
    assert body["withChat"] == 1
    assert "chat_id" not in res.text and "806" not in res.text
    assert _row(client.app.state.pool, 1)["energy_reminded_at"] is None


def test_owner_test_reminder_goes_only_to_the_group_creator(client):
    pool = client.app.state.pool
    tg = FakeTelegram()
    assert reminders.send_owner_test(pool, "t", "@zyronchain", PLAY, NOW, tg)["reason"] == "owner_has_no_private_chat"
    client.get("/api/me", headers=auth(501))
    result = reminders.send_owner_test(pool, "t", "@zyronchain", PLAY, NOW, tg)
    assert result == {"sent": True, "reason": "sent_to_owner"}
    sends = tg.sends()
    assert len(sends) == 1 and sends[0]["chat_id"] == 501
    assert sends[0]["text"].startswith("Test reminder")


def test_reminders_migration_is_idempotent(client):
    sql = Path("migrations/004_reminders.sql").read_text(encoding="utf-8")
    with client.app.state.pool.connection() as conn:
        for statement in split_sql(sql):
            conn.execute(statement)  # second run must be a no-op
    for line in sql.splitlines():
        if line.startswith(("ALTER", "CREATE")):
            assert "IF NOT EXISTS" in line


def test_bot_runs_the_reminder_loop():
    source = Path("src/zyron_node/bot.py").read_text(encoding="utf-8")
    assert "reminders.reminder_loop" in source
    assert "settings.reminders_enabled" in source
    assert reminders.CHECK_SECONDS <= 120
    assert reminders.ACTIVE_SKIP_SECONDS == 300
    assert date(2026, 1, 1)  # keep import used

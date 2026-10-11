import re
from pathlib import Path
from datetime import datetime, timedelta, timezone

from tests.test_economy_and_auth import sign_init
from zyron_node import community
from zyron_node.bot import COMMANDS, handle_update
from zyron_node.telegram_api import TelegramError

SUNDAY = datetime(2026, 10, 4, 12, 5, tzinfo=timezone.utc)
SATURDAY = SUNDAY - timedelta(days=1)
GROUP = {"id": -1001234, "type": "supergroup", "username": "zyronchain", "title": "ZYRONCHAIN"}
BANNED_WORDS = ("price", "invest", "profit", "moon", "pump", "guarantee", "airdrop", "returns", "financial")


def auth(user_id, when, start=None):
    return {"Authorization": "tma " + sign_init(user_id, int(when.timestamp()), start_param=start), "X-Test-Now": when.isoformat()}


class FakeTelegram:
    def __init__(self, member=None, chat=None, fail=None):
        self.calls = []
        self.member = member or {"status": "member"}
        self.chat = chat or {"id": GROUP["id"], "type": "supergroup", "title": "ZYRONCHAIN", "permissions": {}}
        self.fail = fail or {}

    def __call__(self, token, method, payload, timeout=15):
        self.calls.append((method, payload))
        if method in self.fail:
            raise self.fail[method]
        n = len(self.calls)
        if method == "sendPoll":
            return {"ok": True, "result": {"message_id": n, "chat": {"id": GROUP["id"]}, "poll": {"id": f"poll{n}"}}}
        if method == "getMe":
            return {"ok": True, "result": {"id": 999, "username": "ZyronNodeBot", "can_read_all_group_messages": False}}
        if method == "getChat":
            return {"ok": True, "result": self.chat}
        if method == "getChatMember":
            return {"ok": True, "result": self.member}
        return {"ok": True, "result": {"message_id": n}}

    def of(self, method):
        return [p for m, p in self.calls if m == method]


def build_blocks(client, user_id, when, count):
    assert client.get("/api/me", headers=auth(user_id, when)).status_code == 200
    for i in range(count):
        at = when + timedelta(seconds=2 * (i + 1))
        res = client.post("/api/cycle", json={"idempotencyKey": f"b-{user_id}-{at.timestamp():.0f}"}, headers=auth(user_id, at))
        assert res.status_code == 200, res.text


def test_quiz_bank_is_true_short_and_honest():
    assert len(community.QUESTIONS) >= 9
    ids = [q.id for q in community.QUESTIONS]
    assert len(ids) == len(set(ids))
    for q in community.QUESTIONS:
        assert len(q.text) <= 300 and 2 <= len(q.options) <= 10
        assert all(len(o) <= 100 for o in q.options)
        assert len(q.explanation) <= 200
        assert 0 <= q.correct < len(q.options)
    corpus = " ".join(q.text + " " + " ".join(q.options) + " " + q.explanation for q in community.QUESTIONS).lower()
    for word in BANNED_WORDS:
        assert word not in corpus
    assert not re.search(r"\bmin(er|ers|ing)\b", corpus)
    facts = {q.id: q.options[q.correct] for q in community.QUESTIONS}
    assert facts["supply"] == "50 million"
    assert facts["keys"] == "On your own device"
    assert facts["testnet"] == "Testnet only"
    assert facts["opensource"].startswith("Yes, it is open source")


def test_quiz_rotation_and_schedule():
    for week in range(1, 53):
        picked = community.quiz_questions(f"2026-W{week:02d}")
        assert len({q.id for q in picked}) == 3
    wednesday = datetime(2026, 10, 7, 16, 0, tzinfo=timezone.utc)
    assert community.quiz_due(wednesday)
    assert not community.quiz_due(wednesday - timedelta(minutes=1))
    assert community.quiz_due(wednesday + timedelta(hours=23, minutes=59))
    assert not community.quiz_due(wednesday + timedelta(hours=24, minutes=1))


def test_daily_board_posts_once_and_skips_without_data(client):
    pool = client.app.state.pool
    settings = client.app.state.settings
    tg = FakeTelegram()
    monday = datetime(2026, 10, 5, 12, 5, tzinfo=timezone.utc)
    assert community.post_leaderboard(pool, settings, monday, tg)["reason"] == "no_data"
    assert tg.of("sendMessage") == []
    assert community.post_leaderboard(pool, settings, monday, tg)["reason"] == "already_done"

    build_blocks(client, 901, monday + timedelta(hours=1), 3)
    build_blocks(client, 902, monday + timedelta(hours=2), 1)
    tuesday = monday + timedelta(days=1)
    early = community.post_leaderboard(pool, settings, tuesday.replace(hour=9), tg)
    assert early["reason"] == "not_yet"
    result = community.post_leaderboard(pool, settings, tuesday, tg)
    assert result["posted"] is True and result["daily"] == 2
    sent = tg.of("sendMessage")
    assert len(sent) == 1
    assert sent[0]["chat_id"] == "@zyronchain"
    text = sent[0]["text"]
    assert "Top block builders · Mon Oct 5 (UTC)" in text
    assert "3 blocks" in text and "1 block" in text
    assert "Weekly" not in text  # only on Sunday
    assert "off-chain" in text
    button = sent[0]["reply_markup"]["inline_keyboard"][0][0]
    assert button["url"] == "https://t.me/ZyronNodeBot?start=play" and "web_app" not in button
    assert community.post_leaderboard(pool, settings, tuesday + timedelta(hours=3), tg)["reason"] == "already_done"
    assert len(tg.of("sendMessage")) == 1


def test_sunday_adds_weekly_summary_and_qualified_invites_only(client):
    pool = client.app.state.pool
    settings = client.app.state.settings
    tuesday = SUNDAY - timedelta(days=5)
    build_blocks(client, 911, tuesday, 2)
    me = client.get("/api/me", headers=auth(911, tuesday)).json()
    code = me["player"]["referral"]["code"]
    # A referee who passes the checks (2 cycles with REFERRAL_MIN_CYCLES=2) counts.
    build_blocks(client, 912, tuesday + timedelta(hours=1), 2)
    client.get("/api/me", headers=auth(913, tuesday + timedelta(hours=2), start="ref_" + code))
    build_blocks(client, 913, tuesday + timedelta(hours=2), 2)
    # A rejected referral never counts.
    with pool.connection() as conn:
        conn.execute("UPDATE players SET referred_by_id = NULL WHERE telegram_id = 912")
        conn.execute(
            """
            INSERT INTO referrals (referrer_id, referee_id, status, created_at)
            SELECT r.id, e.id, 'rejected', %s FROM players r, players e WHERE r.telegram_id = 911 AND e.telegram_id = 912
            """,
            (tuesday,),
        )
        statuses = conn.execute("SELECT status FROM referrals ORDER BY id").fetchall()
    assert [s["status"] for s in statuses] == ["rewarded", "rejected"]
    build_blocks(client, 914, SATURDAY.replace(hour=10), 1)
    tg = FakeTelegram()
    result = community.post_leaderboard(pool, settings, SUNDAY, tg)
    assert result["posted"] and result["weekly"] == 4 and result["invites"] == 1
    text = tg.of("sendMessage")[0]["text"]
    assert "Top block builders · Sat Oct 3 (UTC)" in text
    assert "Weekly summary · Sep 27 – Oct 3 (UTC)" in text
    assert "Weekly invite contest (qualified invites only)" in text
    invite_block = text.split("Weekly invite contest", 1)[1]
    assert "1 invite" in invite_block and "2 invites" not in invite_block
    lowered = text.lower()
    for word in BANNED_WORDS:
        assert word not in lowered
    assert not re.search(r"\bmin(er|ers|ing)\b", lowered)


def test_group_texts_never_use_the_retired_word():
    source = Path("src/zyron_node/community.py").read_text(encoding="utf-8")
    assert "POINTS_NOTICE)" not in source and "{POINTS_NOTICE}" not in source and "+ POINTS_NOTICE" not in source
    assert not re.search(r"\bmin(er|ers|ing)\b", community.COMMUNITY_NOTICE.lower())
    assert "off-chain" in community.COMMUNITY_NOTICE


def test_banned_players_stay_off_the_board(client):
    pool = client.app.state.pool
    build_blocks(client, 921, SATURDAY.replace(hour=9), 2)
    with pool.connection() as conn:
        conn.execute("UPDATE players SET banned = TRUE WHERE telegram_id = 921")
    assert community.leaderboard_post(pool, SUNDAY) is None


def test_quiz_scores_server_side_once_per_user_with_a_cap(client):
    pool = client.app.state.pool
    settings = client.app.state.settings
    wednesday = datetime(2026, 10, 7, 16, 1, tzinfo=timezone.utc)
    tg = FakeTelegram()
    result = community.post_quiz(pool, settings, wednesday, tg)
    assert result["posted"] and len(result["polls"]) == 3
    assert community.post_quiz(pool, settings, wednesday + timedelta(hours=1), tg)["reason"] == "already_done"
    polls = tg.of("sendPoll")
    assert len(polls) == 3
    assert all(p["type"] == "quiz" and p["is_anonymous"] is False for p in polls)
    intro = tg.of("sendMessage")[0]["text"]
    assert "20 Zyron Points" in intro and "max 60" in intro and "off-chain" in intro
    with pool.connection() as conn:
        rows = conn.execute("SELECT poll_id, correct_option FROM quiz_polls ORDER BY message_id").fetchall()
    client.get("/api/me", headers=auth(931, wednesday))
    at = wednesday + timedelta(minutes=5)
    first = rows[0]
    right = {"poll_id": first["poll_id"], "user": {"id": 931}, "option_ids": [first["correct_option"]]}
    assert community.record_quiz_answer(pool, right, at) == {"recorded": True, "correct": True, "points": 20}
    assert community.record_quiz_answer(pool, right, at)["reason"] == "already_answered"
    wrong_option = (rows[1]["correct_option"] + 1) % 3
    wrong = {"poll_id": rows[1]["poll_id"], "user": {"id": 931}, "option_ids": [wrong_option]}
    assert community.record_quiz_answer(pool, wrong, at)["points"] == 0
    stranger = {"poll_id": first["poll_id"], "user": {"id": 932}, "option_ids": [first["correct_option"]]}
    assert community.record_quiz_answer(pool, stranger, at)["reason"] == "not_a_player"
    late = {"poll_id": rows[2]["poll_id"], "user": {"id": 931}, "option_ids": [rows[2]["correct_option"]]}
    assert community.record_quiz_answer(pool, late, wednesday + timedelta(days=7))["reason"] == "closed"
    # Cap: even with extra polls in the same quiz, one user tops out at QUIZ_MAX_POINTS.
    with pool.connection() as conn:
        for i in range(3):
            conn.execute(
                "INSERT INTO quiz_polls VALUES (%s, %s, 'x', 0, '-1', %s, %s, %s, FALSE)",
                (f"extra{i}", community.quiz_key(wednesday), 900 + i, wednesday, wednesday + timedelta(days=6)),
            )
    gained = [community.record_quiz_answer(pool, {"poll_id": f"extra{i}", "user": {"id": 931}, "option_ids": [0]}, at)["points"] for i in range(3)]
    assert gained == [20, 20, 0]
    me = client.get("/api/me", headers=auth(931, at)).json()["player"]
    assert me["points"] == 60
    # Polls are stopped once closed.
    stopped = community.stop_expired_quizzes(pool, "t", wednesday + timedelta(days=6, minutes=1), tg)
    assert stopped == 6 and len(tg.of("stopPoll")) >= 3


def test_poll_answers_arrive_through_the_bot(client):
    pool = client.app.state.pool
    settings = client.app.state.settings
    wednesday = datetime(2026, 10, 7, 16, 1, tzinfo=timezone.utc)
    community.post_quiz(pool, settings, wednesday, FakeTelegram())
    with pool.connection() as conn:
        row = conn.execute("SELECT poll_id FROM quiz_polls LIMIT 1").fetchone()
        conn.execute("UPDATE quiz_polls SET closes_at = now() + interval '1 day'")
    handle_update(pool, settings, {"poll_answer": {"poll_id": row["poll_id"], "user": {"id": 941}, "option_ids": [0]}}, call=FakeTelegram())
    with pool.connection() as conn:
        assert conn.execute("SELECT count(*) AS n FROM quiz_answers").fetchone()["n"] == 1


def test_welcome_is_short_rate_limited_and_cleaned_up(client):
    pool = client.app.state.pool
    settings = client.app.state.settings
    tg = FakeTelegram()
    now = SUNDAY
    join = {"chat": GROUP, "new_chat_members": [{"id": 5, "first_name": "Ada"}, {"id": 6, "first_name": "Bot", "is_bot": True}]}
    sent = community.welcome(pool, settings, join, now, tg)
    assert sent["sent"] is True
    payload = tg.of("sendMessage")[0]
    assert "Ada" in payload["text"] and "Bot" not in payload["text"]
    assert "testnet" in payload["text"] and "2 minutes" in payload["text"]
    assert len(payload["text"]) < 400
    buttons = payload["reply_markup"]["inline_keyboard"][0]
    assert [b["text"] for b in buttons] == ["Play ZYRON NODE", "Phone wallet (testnet)"]
    assert buttons[1]["url"] == "https://zyronchain.com/app/"
    assert community.welcome(pool, settings, join, now + timedelta(seconds=30), tg)["reason"] == "cooldown"
    assert community.welcome(pool, settings, {"chat": GROUP, "new_chat_members": [{"id": 7, "is_bot": True}]}, now, tg)["reason"] == "no_humans"
    assert community.delete_due_welcomes(pool, "t", now + timedelta(seconds=60), tg) == 0
    assert community.delete_due_welcomes(pool, "t", now + timedelta(seconds=121), tg) == 1
    deleted = tg.of("deleteMessage")
    assert deleted == [{"chat_id": str(GROUP["id"]), "message_id": sent["messageId"]}]
    assert community.welcome(pool, settings, join, now + timedelta(seconds=91), tg)["sent"] is True
    # Burst: many joins in one minute produce at most one note.
    for i in range(10):
        community.welcome(pool, settings, join, now + timedelta(seconds=100 + i), tg)
    assert len(tg.of("sendMessage")) == 2


def test_welcome_only_in_the_community_group(client):
    tg = FakeTelegram()
    other = {"message": {"chat": {"id": -5, "type": "group", "username": "elsewhere"}, "new_chat_members": [{"id": 5, "first_name": "Ada"}]}}
    handle_update(client.app.state.pool, client.app.state.settings, other, call=tg)
    assert tg.calls == []
    ours = {"message": {"chat": GROUP, "new_chat_members": [{"id": 5, "first_name": "Ada"}]}}
    handle_update(client.app.state.pool, client.app.state.settings, ours, call=tg)
    assert len(tg.of("sendMessage")) == 1


def test_info_commands_are_honest_and_rate_limited_in_groups(client):
    pool = client.app.state.pool
    settings = client.app.state.settings
    community._command_seen.clear()
    community._stats_cache.clear()
    tg = FakeTelegram()
    msg = {"message": {"text": "/stats@ZyronNodeBot", "from": {"id": 1}, "chat": GROUP}}
    handle_update(pool, settings, msg, call=tg)
    handle_update(pool, settings, msg, call=tg)  # within 30 s: ignored
    stats = tg.of("sendMessage")
    assert len(stats) == 1
    assert "Players:" in stats[0]["text"] and "testnet" in stats[0]["text"] and "off-chain" in stats[0]["text"]
    for command, needle in (("/wallet", "https://zyronchain.com/app/"), ("/roadmap", "no dates promised")):
        handle_update(pool, settings, {"message": {"text": command, "from": {"id": 1}, "chat": {"id": 1, "type": "private"}}}, call=tg)
        assert needle in tg.of("sendMessage")[-1]["text"]
    assert "testnet only" in community.WALLET_TEXT
    for text in (community.WALLET_TEXT, community.ROADMAP_TEXT, community.NETWORK_STATUS):
        lowered = text.lower()
        assert not re.search(r"\bmin(er|ers|ing)\b", lowered)
        for word in BANNED_WORDS:
            assert word not in lowered
    registered = {c["command"] for c in COMMANDS}
    assert {"stats", "wallet", "roadmap", "help", "reminders"} <= registered


def test_rights_report_names_whats_missing():
    ok = community.rights_report("t", "@zyronchain", FakeTelegram(member={"status": "administrator", "can_delete_messages": True}))
    assert ok["ok"] is True and ok["member"]["admin"] is True and ok["adminRequired"] is False
    muted = community.rights_report("t", "@zyronchain", FakeTelegram(
        chat={"id": 1, "type": "supergroup", "permissions": {"can_send_messages": True, "can_send_polls": False}}))
    assert muted["missing"] == ["send_polls"]
    gone = community.rights_report("t", "@zyronchain", FakeTelegram(member={"status": "left"}))
    assert gone["missing"] == ["bot_not_in_group"]
    hidden = community.rights_report("t", "@zyronchain", FakeTelegram(fail={"getChat": TelegramError("getChat", 400, "chat not found")}))
    assert hidden["missing"] == ["bot_cannot_see_group"]


def test_admin_leaderboard_preview_is_a_dry_run(client):
    assert client.post("/api/admin/community/leaderboard", json={}).status_code == 401
    headers = {"Authorization": "Bearer test-admin-token", "X-Test-Now": SUNDAY.isoformat()}
    res = client.post("/api/admin/community/leaderboard", json={}, headers=headers)
    assert res.status_code == 200, res.text
    assert res.json() == {"dryRun": True, "hasData": False, "text": None}
    assert client.get("/api/admin/community").status_code == 401

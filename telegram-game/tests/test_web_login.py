"""ZYRON HUB read-only web sign-in: bot-issued one-time code, session isolation, expiry, replay and forgery."""

import re
from datetime import datetime, timedelta, timezone

from tests.test_api import auth
from zyron_node.bot import handle_update
from zyron_node import web_login


class FakeTelegram:
    def __init__(self):
        self.calls = []

    def __call__(self, token, method, payload, timeout=15):
        self.calls.append((method, payload))
        return {"ok": True, "result": {}}


def real_now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def clock(when):
    return {"X-Test-Now": when.isoformat()}


def play(client, user):
    when = real_now()
    response = client.get("/api/me", headers=auth(user, when))
    assert response.status_code == 200, response.text
    return response.json()["player"]


def start(client, when=None):
    response = client.post("/api/web/login/start", headers=clock(when or real_now()))
    assert response.status_code == 200, response.text
    return response.json()


def bot_start(client, user, login, chat_type="private"):
    tg = FakeTelegram()
    update = {"message": {"text": f"/start web_{login['loginId']}", "from": {"id": user, "first_name": "T"}, "chat": {"id": user, "type": chat_type}}}
    handle_update(client.app.state.pool, client.app.state.settings, update, call=tg)
    sent = [p for m, p in tg.calls if m == "sendMessage"]
    assert sent, tg.calls
    text = sent[-1]["text"]
    match = re.search(r"code: ([A-Z0-9]{4})-([A-Z0-9]{4})", text)
    return (match.group(1) + match.group(2)) if match else None, text


def finish(client, login, code, when=None, secret=None):
    return client.post(
        "/api/web/login/finish",
        json={"loginId": login["loginId"], "secret": secret or login["secret"], "code": code},
        headers=clock(when or real_now()),
    )


def me(client, token, when=None):
    return client.get("/api/web/me", headers={"Authorization": f"zws {token}", **clock(when or real_now())})


def sign_in(client, user):
    login = start(client)
    code, _ = bot_start(client, user, login)
    response = finish(client, login, code)
    assert response.status_code == 200, response.text
    return response.json()["token"]


def test_full_flow_reads_the_same_records_as_telegram(client):
    player = play(client, 7101)
    login = start(client)
    assert login["botLink"] == f"https://t.me/ZyronNodeBot?start=web_{login['loginId']}"
    assert login["ttlSeconds"] == 120
    code, text = bot_start(client, 7101, login)
    assert code and "Never share it" in text
    response = finish(client, login, code.lower()[:4] + "-" + code.lower()[4:])
    assert response.status_code == 200, response.text
    data = me(client, response.json()["token"]).json()
    assert data["readOnly"] is True
    assert data["points"]["balance"] == player["points"]
    assert data["profile"]["level"] == player["level"]
    assert data["energy"]["max"] == player["energy"]["max"]
    assert data["wallet"] == {"linked": False, "verified": False, "address": None}
    assert len(data["upgrades"]) == 7 and data["achievements"]["total"] > 0
    assert set(data["rank"]) == {"daily", "weekly", "season", "alltime"}
    assert "invited" in data["invites"]


def test_one_user_cannot_read_another_users_data(client):
    play(client, 7201)
    play(client, 7202)
    token_a = sign_in(client, 7201)
    token_b = sign_in(client, 7202)
    a = me(client, token_a).json()
    b = me(client, token_b).json()
    assert a["invites"]["link"] != b["invites"]["link"]
    # Client-supplied ids are ignored: query strings and dev headers never change whose data is returned.
    spoof = client.get("/api/web/me?telegram_id=7202&player=2", headers={"Authorization": f"zws {token_a}", "X-Dev-Telegram-Id": "7202", **clock(real_now())})
    assert spoof.json()["invites"]["link"] == a["invites"]["link"]
    # A Telegram initData header is not a web session, and a forged token is rejected.
    assert client.get("/api/web/me", headers=auth(7202, real_now())).status_code == 401
    assert me(client, "0" * 64).status_code == 401
    assert me(client, token_a[:-1] + ("0" if token_a[-1] != "0" else "1")).status_code == 401


def test_code_is_one_time_and_replay_is_refused(client):
    play(client, 7301)
    login = start(client)
    code, _ = bot_start(client, 7301, login)
    assert finish(client, login, code).status_code == 200
    replay = finish(client, login, code)
    assert replay.status_code == 410 and replay.json()["error"]["code"] == "login_used"
    # Re-opening the same link in Telegram never issues a fresh code.
    again, text = bot_start(client, 7301, login)
    assert again is None and "expired or was already used" in text


def test_expired_request_and_expired_code(client):
    play(client, 7401)
    t0 = real_now()
    unconfirmed = start(client, t0)
    late = finish(client, unconfirmed, "ABCDEFGH", when=t0 + timedelta(seconds=121))
    assert late.status_code == 410 and late.json()["error"]["code"] == "login_expired"
    login = start(client)
    code, _ = bot_start(client, 7401, login)
    expired = finish(client, login, code, when=real_now() + timedelta(seconds=125))
    assert expired.status_code == 410 and expired.json()["error"]["code"] == "login_expired"
    assert finish(client, login, code).status_code == 410  # burned


def test_forged_codes_secrets_and_ids(client):
    play(client, 7501)
    login = start(client)
    code, _ = bot_start(client, 7501, login)
    wrong_secret = finish(client, login, code, secret="f" * 64)
    assert wrong_secret.status_code == 400 and wrong_secret.json()["error"]["code"] == "login_invalid"
    bad = client.post("/api/web/login/finish", json={"loginId": "x" * 32, "secret": "0" * 64, "code": code}, headers=clock(real_now()))
    assert bad.status_code in {400, 422}
    for _ in range(4):
        assert finish(client, login, "AAAAAAAA").json()["error"]["code"] == "login_code"
    assert finish(client, login, "AAAAAAAA").json()["error"]["code"] == "login_used"
    assert finish(client, login, code).status_code == 410  # the right code no longer helps


def test_pending_request_cannot_finish_and_double_confirm_burns(client):
    play(client, 7601)
    play(client, 7602)
    login = start(client)
    pending = finish(client, login, "ABCDEFGH")
    assert pending.status_code == 409
    code, _ = bot_start(client, 7601, login)
    other, text = bot_start(client, 7602, login)  # a second account opening the same link closes it
    assert other is None and "already confirmed" in text
    assert finish(client, login, code).status_code == 410


def test_group_chat_never_issues_a_code(client):
    login = start(client)
    tg = FakeTelegram()
    update = {"message": {"text": f"/start web_{login['loginId']}", "from": {"id": 7701}, "chat": {"id": -100, "type": "supergroup"}}}
    handle_update(client.app.state.pool, client.app.state.settings, update, call=tg)
    assert not any(re.search(r"code: ", p.get("text", "")) for m, p in tg.calls if m == "sendMessage")


def test_logout_revokes_and_sessions_expire(client):
    play(client, 7801)
    token = sign_in(client, 7801)
    assert me(client, token).status_code == 200
    assert me(client, token, when=real_now() + timedelta(minutes=31)).status_code == 401
    assert client.post("/api/web/logout", headers={"Authorization": f"zws {token}", **clock(real_now())}).status_code == 200
    assert me(client, token).status_code == 401


def test_web_read_is_read_only(client):
    play(client, 7901)
    token = sign_in(client, 7901)
    with client.app.state.pool.connection() as conn:
        before = dict(conn.execute("SELECT * FROM players WHERE telegram_id = 7901").fetchone())
    assert me(client, token, when=real_now() + timedelta(minutes=10)).status_code == 200
    with client.app.state.pool.connection() as conn:
        after = dict(conn.execute("SELECT * FROM players WHERE telegram_id = 7901").fetchone())
    assert before == after


def test_unknown_player_and_rate_limits(client):
    token = sign_in(client, 7999)  # never opened the game
    assert me(client, token).json()["error"]["code"] == "no_player"
    codes = [client.post("/api/web/login/start", headers=clock(real_now())).status_code for _ in range(12)]
    assert 429 in codes


def test_cors_allows_the_hub_only_on_hosted_deployments(monkeypatch, settings):
    from zyron_node.config import load_settings

    assert "https://zyronchain.com" not in settings.cors_origins
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("CORS_ORIGINS", "https://example.org")
    hosted = load_settings()
    assert "https://zyronchain.com" in hosted.cors_origins
    assert "https://example.org" in hosted.cors_origins
    assert "https://zyron249.github.io" in hosted.cors_origins


def test_login_id_param_parsing():
    assert web_login.login_id_from_param("web_" + "a" * 32) == "a" * 32
    assert web_login.login_id_from_param("web_" + "A" * 32) is None
    assert web_login.login_id_from_param("ref_ABCDEFGH") is None
    assert web_login.login_id_from_param("") is None


def test_wrong_code_attempts_are_persisted(client):
    play(client, 8001)
    login = start(client)
    bot_start(client, 8001, login)
    finish(client, login, "AAAAAAAA")
    with client.app.state.pool.connection() as conn:
        row = conn.execute("SELECT attempts, code_hash, secret_hash FROM web_logins WHERE login_id = %s", (login["loginId"],)).fetchone()
    assert row["attempts"] == 1
    # Only hashes are stored, never the secret or the code.
    assert login["secret"] not in (row["code_hash"], row["secret_hash"])

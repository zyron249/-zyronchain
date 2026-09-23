import hashlib
import hmac
import json
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlencode

import pytest

from zyron_node.auth import AuthError, verify_init_data
from zyron_node.config import ConfigError, validate_rpc_base, validate_settings, load_settings
from zyron_node.economy import (
    MODULES,
    STREAK_REWARDS,
    advance_streak,
    apply_energy,
    cycle_reward,
    empty_levels,
    max_energy,
    network_power,
    level_chest_reward,
    streak_reward,
    upgrade_cost,
)
from zyron_node.rpc import ChainClient, RpcError, format_zyn, summarize_blocks, valid_watch_address

BOT = "123456:TEST_TOKEN_NOT_A_SECRET"


def sign_init(user_id, auth_date, token=BOT, start_param=None, username="ada"):
    user = json.dumps({"id": user_id, "first_name": "Ada", "username": username}, separators=(",", ":"))
    fields = {"auth_date": str(auth_date), "user": user}
    if start_param:
        fields["start_param"] = start_param
    check = "\n".join(f"{key}={fields[key]}" for key in sorted(fields))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    digest = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode({**fields, "hash": digest})


def test_upgrade_costs_increase_and_cycle_reward_is_bounded():
    for module, spec in MODULES.items():
        previous = 0
        for level in range(spec.max_level):
            cost = upgrade_cost(module, level)
            assert cost > previous
            previous = cost
        with pytest.raises(ValueError):
            upgrade_cost(module, spec.max_level)
    assert cycle_reward(empty_levels(), 0) == 1
    assert cycle_reward(empty_levels(), 0) <= 250
    rich = {name: spec.max_level for name, spec in MODULES.items()}
    assert 1 <= cycle_reward(rich, 40) <= 250
    assert network_power(rich) > network_power(empty_levels())


def test_energy_regen_respects_cap_and_remainder():
    levels = empty_levels()
    start = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)
    energy, updated = apply_energy(0, start, start + timedelta(seconds=600), levels)
    assert energy == 2
    assert updated == start + timedelta(seconds=600)
    capped, _ = apply_energy(max_energy(levels), start, start + timedelta(days=3), levels)
    assert capped == max_energy(levels)


def test_level_chest_reward_is_deterministic():
    assert level_chest_reward(2) == 10
    assert level_chest_reward(3) == 20
    assert level_chest_reward(10) == 90
    with pytest.raises(ValueError):
        level_chest_reward(1)


def test_streak_calendar_and_gaps():
    assert len(STREAK_REWARDS) == 31
    assert streak_reward(1) == 10
    assert streak_reward(7) == 120
    assert streak_reward(30) == 280
    assert streak_reward(45) == 280
    today = date(2026, 9, 22)
    assert advance_streak(None, 0, today) == (1, True)
    assert advance_streak(today, 1, today) == (1, False)
    assert advance_streak(today - timedelta(days=1), 4, today) == (5, True)
    assert advance_streak(today - timedelta(days=2), 4, today) == (1, True)


def test_init_data_rejects_tampering_and_expiry():
    now = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)
    payload = sign_init(42, int(now.timestamp()))
    identity = verify_init_data(payload, BOT, now, 3600)
    assert identity.id == 42
    assert identity.username == "ada"
    tampered = payload.replace("Ada", "Eve")
    with pytest.raises(AuthError):
        verify_init_data(tampered, BOT, now, 3600)
    old = sign_init(42, int(now.timestamp()) - 10_000)
    with pytest.raises(AuthError):
        verify_init_data(old, BOT, now, 3600)


def test_rpc_allowlist_and_summary():
    calls = []

    def fetch(url, headers, timeout):
        calls.append(url)
        assert headers["x-zyron-rpc-version"] == "1"
        if url.endswith("/status"):
            body = {"chainId": "zyron-local-abc", "genesisHash": "aa", "height": 3, "tipHash": "bb"}
        elif url.endswith("/protocol"):
            body = {"currentVersion": 1, "nextVersion": 1}
        elif url.endswith("/healthz"):
            body = {"ok": True, "height": 3}
        elif "/blocks?" in url:
            body = {
                "blocks": [
                    {
                        "hash": "abcdef1234567890ffff",
                        "header": {"height": 3, "timestampMs": 10},
                        "transactions": [
                            {"kind": "transfer", "sender": "ZYN" + "ab" * 20, "signature": "secret-signature"}
                        ],
                    }
                ]
            }
        elif "/balance/" in url:
            body = {"address": url.rsplit("/", 1)[-1], "balanceAtoms": 100_000_000}
        elif "/nonce/" in url:
            body = {"address": url.rsplit("/", 1)[-1], "nonce": 4}
        else:
            raise AssertionError(url)
        return 200, json.dumps(body), {"x-zyron-rpc-version": "1"}

    client = ChainClient(
        base_url="http://127.0.0.1:9137",
        allow_remote=False,
        pool=None,
        fetch=fetch,
        redis_url=None,
    )
    address = "ZYN" + "ab" * 20
    panel = client.panel(address)
    assert panel["reachable"] is True
    assert panel["height"] == 3
    assert panel["wallet"]["balanceZyn"] == "1.00000000"
    assert panel["recentBlocks"][0]["involvesWallet"] is True
    assert "secret-signature" not in json.dumps(panel)
    assert all("/tx" not in url and url.startswith("http://127.0.0.1:9137/") for url in calls)
    with pytest.raises(RpcError):
        client.get_json("/tx", ttl=5)
    with pytest.raises(ConfigError):
        ChainClient("http://example.com", False, None, fetch).get_json("/status", ttl=5)
    assert valid_watch_address(address)
    assert not valid_watch_address("ZYN" + "0" * 40)
    assert not valid_watch_address("ZYN" + "AB" * 20)
    blocks = summarize_blocks([{"transactions": [{"signature": "nope"}]}], None)
    assert "signature" not in json.dumps(blocks)
    assert format_zyn(1) == "0.00000001"


def test_remote_rpc_policy():
    validate_rpc_base("http://127.0.0.1:9137", False)
    with pytest.raises(ConfigError):
        validate_rpc_base("http://169.254.169.254/status", True)
    with pytest.raises(ConfigError):
        validate_rpc_base("http://rpc.example/status", True)
    validate_rpc_base("https://rpc.example", True)


def test_production_refuses_dev_flags(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("DATABASE_URL", "postgresql://zyron@127.0.0.1/zyron_node")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
    monkeypatch.setenv("WEBAPP_URL", "https://game.example")
    monkeypatch.setenv("ADMIN_TOKEN", "x" * 24)
    monkeypatch.setenv("REFERRAL_IP_SALT", "production-salt-value")
    monkeypatch.setenv("DEV_AUTH_BYPASS", "1")
    with pytest.raises(ConfigError):
        validate_settings(load_settings())

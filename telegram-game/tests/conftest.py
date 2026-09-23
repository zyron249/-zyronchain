import os
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from zyron_node.app import create_app
from zyron_node.config import load_settings

BOT_TOKEN = "123456:TEST_TOKEN_NOT_A_SECRET"


@pytest.fixture
def settings(monkeypatch):
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        pytest.skip("DATABASE_URL is required for ZYRON NODE integration tests")
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("ALLOW_TEST_CLOCK", "1")
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", BOT_TOKEN)
    monkeypatch.setenv("TELEGRAM_BOT_USERNAME", "ZyronNodeBot")
    monkeypatch.setenv("ADMIN_TOKEN", "test-admin-token")
    monkeypatch.setenv("REFERRAL_IP_SALT", "test-salt-value-ok")
    monkeypatch.setenv("DEV_AUTH_BYPASS", "0")
    monkeypatch.setenv("ZYRON_RPC_URL", "")
    monkeypatch.setenv("ZYRON_RPC_ALLOW_REMOTE", "0")
    monkeypatch.setenv("REFERRAL_MIN_AGE_SECONDS", "0")
    monkeypatch.setenv("REFERRAL_MIN_CYCLES", "2")
    monkeypatch.setenv("CYCLE_MIN_INTERVAL_MS", "800")
    monkeypatch.setenv("WEBAPP_URL", "")
    return load_settings()


@pytest.fixture
def client(settings):
    app = create_app(settings)
    with TestClient(app) as test_client:
        with app.state.pool.connection() as conn:
            with conn.transaction():
                conn.execute(
                    """
                    TRUNCATE TABLE
                        chest_claims,
                        players,
                        season_snapshots,
                        chain_cache,
                        rate_limits,
                        admin_audit,
                        pending_referrals
                    RESTART IDENTITY CASCADE
                    """
                )
                conn.execute(
                    """
                    UPDATE seasons
                    SET status = 'active', ends_at = NULL
                    WHERE name = 'Season 0'
                    """
                )
        yield test_client

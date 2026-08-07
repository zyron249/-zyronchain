import app as app_module


def test_admin_api_disabled_when_token_is_not_configured(monkeypatch):
    monkeypatch.setattr(app_module, "ADMIN_TOKEN", None)
    client = app_module.app.test_client()

    response = client.get("/debug/db")

    assert response.status_code == 503


def test_admin_api_rejects_wrong_token(monkeypatch):
    monkeypatch.setattr(app_module, "ADMIN_TOKEN", "correct-token")
    client = app_module.app.test_client()

    response = client.get(
        "/debug/db",
        headers={"X-Zyron-Admin-Token": "wrong-token"}
    )

    assert response.status_code == 403


def test_admin_api_accepts_correct_token_without_leaking_database_url(monkeypatch):
    monkeypatch.setattr(app_module, "ADMIN_TOKEN", "correct-token")
    monkeypatch.setattr(
        app_module.chain.storage,
        "database_url",
        "postgresql://secret-user:secret-password@example.invalid/zyron"
    )
    client = app_module.app.test_client()

    response = client.get(
        "/debug/db",
        headers={"X-Zyron-Admin-Token": "correct-token"}
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["database_url_exists"] is True
    assert "database_url_prefix" not in payload
    assert "secret-user" not in response.get_data(as_text=True)
    assert "secret-password" not in response.get_data(as_text=True)


def test_server_side_wallet_secret_endpoints_are_disabled():
    client = app_module.app.test_client()

    create_response = client.get("/wallet/new")
    recover_response = client.post(
        "/wallet/recover",
        json={"mnemonic": "do not send secrets to the node"}
    )

    assert create_response.status_code == 410
    assert recover_response.status_code == 410


def test_testnet_faucet_is_disabled_by_default(monkeypatch):
    monkeypatch.setattr(app_module, "ENABLE_TESTNET_FAUCET", False)
    client = app_module.app.test_client()

    response = client.get(
        "/faucet/ZYN1234567890abcdef1234567890abcdef123456"
    )

    assert response.status_code == 503

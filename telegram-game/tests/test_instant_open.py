"""Instant open: static Play Zyron shell, waking state, CORS, bot URL, points mark, English-only."""

import re
import shutil
import struct
import subprocess
import sys
import unicodedata
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from zyron_node.app import create_app
from zyron_node.bot import menu_button_payload
from zyron_node.buildinfo import CLIENT_BUILD
from zyron_node.config import DEFAULT_MINIAPP_URL, ConfigError, load_settings, validate_settings
from zyron_node.shell import STATIC_ASSETS

STATIC_ORIGIN = "https://zyron249.github.io"
FRONTEND = Path("frontend")


@pytest.fixture
def cors_client(settings, monkeypatch):
    monkeypatch.setenv("MINIAPP_URL", DEFAULT_MINIAPP_URL)
    monkeypatch.setenv("CORS_ORIGINS", "")
    app = create_app(load_settings())
    with TestClient(app) as client:
        yield client


def test_cors_allows_only_the_static_origin(cors_client):
    ok = cors_client.get("/healthz", headers={"Origin": STATIC_ORIGIN})
    assert ok.status_code == 200 and ok.json() == {"ok": True, "service": "zyron-node"}
    assert ok.headers["access-control-allow-origin"] == STATIC_ORIGIN
    assert "Origin" in ok.headers["vary"]
    assert "access-control-allow-credentials" not in ok.headers

    evil = cors_client.get("/healthz", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in evil.headers

    pre = cors_client.options("/api/cycle", headers={"Origin": STATIC_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type"})
    assert pre.status_code == 204
    assert pre.headers["access-control-allow-origin"] == STATIC_ORIGIN
    assert pre.headers["access-control-allow-methods"] == "GET, POST"
    assert "Authorization" in pre.headers["access-control-allow-headers"]
    assert "X-Dev-Telegram-Id" not in pre.headers["access-control-allow-headers"]
    assert int(pre.headers["access-control-max-age"]) <= 600

    assert cors_client.options("/api/cycle", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}).status_code == 403
    # Admin routes never answer cross-origin, even for the static origin.
    assert cors_client.options("/api/admin/overview", headers={"Origin": STATIC_ORIGIN, "Access-Control-Request-Method": "GET"}).status_code == 403
    admin = cors_client.get("/api/admin/overview", headers={"Origin": STATIC_ORIGIN})
    assert "access-control-allow-origin" not in admin.headers
    # The shell page itself is not a CORS resource.
    assert "access-control-allow-origin" not in cors_client.get("/", headers={"Origin": STATIC_ORIGIN}).headers

    # Cross-origin calls still need valid Telegram initData (HMAC verified server-side).
    anon = cors_client.get("/api/me", headers={"Origin": STATIC_ORIGIN})
    assert anon.status_code == 401
    assert anon.headers["access-control-allow-origin"] == STATIC_ORIGIN
    forged = cors_client.get("/api/me", headers={"Origin": STATIC_ORIGIN, "Authorization": "tma user=%7B%22id%22%3A1%7D&hash=deadbeef"})
    assert forged.status_code == 401


def _production(monkeypatch, **extra):
    env = {
        "ENVIRONMENT": "production",
        "ALLOW_TEST_CLOCK": "0",
        "DEV_AUTH_BYPASS": "0",
        "ADMIN_TOKEN": "a" * 32,
        "TELEGRAM_BOT_TOKEN": "123456:TEST_TOKEN_NOT_A_SECRET",
        "WEBAPP_URL": "https://zyron-node.onrender.com/",
        "REFERRAL_IP_SALT": "production-salt-value-ok",
        "MINIAPP_URL": "",
        "CORS_ORIGINS": "",
    }
    env.update(extra)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return load_settings()


def test_production_points_play_zyron_at_the_static_host(monkeypatch):
    settings = _production(monkeypatch)
    validate_settings(settings)
    assert settings.miniapp_url == DEFAULT_MINIAPP_URL
    assert settings.cors_origins == (STATIC_ORIGIN,)
    url = menu_button_payload(settings.miniapp_url)["menu_button"]["web_app"]["url"]
    assert url.startswith(DEFAULT_MINIAPP_URL) and url.endswith("v=" + CLIENT_BUILD)
    bot = Path("src/zyron_node/bot.py").read_text(encoding="utf-8")
    assert "settings.miniapp_url" in bot and "settings.webapp_url" not in bot

    with pytest.raises(ConfigError):
        validate_settings(_production(monkeypatch, MINIAPP_URL="http://play.example/"))
    with pytest.raises(ConfigError):
        _production(monkeypatch, CORS_ORIGINS="*")
    with pytest.raises(ConfigError):
        validate_settings(_production(monkeypatch, CORS_ORIGINS="http://other.example"))
    # The API's own origin never needs CORS and is not listed.
    assert "https://zyron-node.onrender.com" not in _production(monkeypatch, CORS_ORIGINS="https://zyron-node.onrender.com").cors_origins


def test_static_build_is_self_contained_and_locked_down(tmp_path):
    sys.path.insert(0, str(Path("scripts").resolve()))
    import build_static  # noqa: PLC0415

    out = tmp_path / "site"
    build_static.build(out, "https://zyron-node.onrender.com")
    html = (out / "index.html").read_text(encoding="utf-8")
    assert "{{" not in html
    csp = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', html).group(1)
    assert "default-src 'none'" in csp
    assert "connect-src https://zyron-node.onrender.com;" in csp
    assert "script-src 'self' https://telegram.org;" in csp
    assert "unsafe-inline" not in csp and "unsafe-eval" not in csp
    assert '<meta name="zyron-api" content="https://zyron-node.onrender.com" />' in html
    assert '<meta name="robots" content="noindex" />' in html
    for name in ("app.js", "styles.css", "boot.js", "boot-recover.js", "wake.js", "logo.png"):
        assert f"./assets/{name}?v={CLIENT_BUILD}" in html
    # The branded splash is static markup, so the first paint never waits for the API or for JavaScript.
    splash = html.split('<div id="app"', 1)[1].split("</div>", 1)[0]
    assert "ZYRON NODE" in splash and "logo.png" in splash and "Connecting" in splash
    assert html.index('id="app"') < html.index("<script src=\"./assets/")
    for name in STATIC_ASSETS:
        assert (out / "assets" / name).read_bytes() == (FRONTEND / name).read_bytes()
    assert (out / ".nojekyll").exists()
    assert "Disallow: /" in (out / "robots.txt").read_text(encoding="utf-8")
    everything = "".join(p.read_text(encoding="utf-8", errors="ignore") for p in out.rglob("*") if p.is_file())
    assert "TELEGRAM_BOT_TOKEN" not in everything and "ADMIN_TOKEN" not in everything
    for bad in ("http://zyron-node.onrender.com", "https://zyron-node.onrender.com/api", "ftp://x"):
        with pytest.raises(SystemExit):
            build_static.build(tmp_path / "bad", bad)


def test_waking_state_flow():
    node = shutil.which("node")
    assert node, "node is required"
    result = subprocess.run([node, "tests/wake.test.js"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "wake ok" in result.stdout
    app = (FRONTEND / "app.js").read_text(encoding="utf-8")
    run_boot = app.split("async function runBoot(token)", 1)[1].split("function boot()", 1)[0]
    # The API is woken with /healthz before any game request, and nothing is sent until it answers.
    assert run_boot.index("waitForServer(token)") < run_boot.index("policy.recoverBoot")
    assert "decoupled: DECOUPLED" in run_boot
    assert 'outcome.phase === "updating"' in run_boot
    assert '"/healthz?t="' in app
    assert "Waking server…" in app
    assert '"data-wake-wait": "1"' in app and 'disabled: "disabled"' in app
    assert 'role: "progressbar"' in app
    assert "retrying automatically" in app
    # One round trip for the rest of the session once the profile is known.
    assert "await Promise.all([" in app.split("async function refresh(options)", 1)[1].split("function render()", 1)[0]
    index = (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert index.index("}}wake.js") < index.index("}}app.js")


def _png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    return struct.unpack(">II", data[16:24])


def test_points_mark_replaces_the_gold_coin(client):
    app = (FRONTEND / "app.js").read_text(encoding="utf-8")
    assert "coinIcon" not in app
    for gold in ("#f3c56b", "#fff1c4", "#c9923a", "#b7812e", "#5a3a10"):
        assert gold not in app.lower(), gold
    assert 'pointsMark("lg")' in app
    assert app.count("pointsMark(") >= 5  # definition + balance, gain toast, chest reveal, leaderboard
    assert '" 1x, "' in app and '" 2x, "' in app and '" 3x"' in app
    for px in (52, 104, 156):
        path = FRONTEND / f"points-mark-{px}.png"
        assert _png_size(path) == (px, px)
        served = client.get(f"/assets/points-mark-{px}.png?v={CLIENT_BUILD}")
        assert served.status_code == 200
        assert served.headers["content-type"].startswith("image/png")
        assert served.content == path.read_bytes()
    assert "off-chain · not ZYN" in app


def test_frontend_is_english_only():
    files = [*FRONTEND.glob("*.js"), *FRONTEND.glob("*.html"), *FRONTEND.glob("*.css"), Path("README.md"), *Path("docs").glob("*.md")]
    for path in files:
        text = path.read_text(encoding="utf-8")
        letters = sorted({ch for ch in text if ord(ch) > 127 and unicodedata.category(ch).startswith("L")})
        assert not letters, f"{path}: non-English letters {''.join(letters)}"


def test_pages_and_keep_warm_workflows():
    root = Path("..", ".github", "workflows")
    pages = (root / "telegram-game-pages.yml").read_text(encoding="utf-8")
    assert "scripts/build_static.py" in pages
    assert "actions/deploy-pages@" in pages and "actions/upload-pages-artifact@" in pages
    assert "github.event_name != 'pull_request'" in pages
    for line in pages.splitlines():
        if line.strip().startswith("uses:"):
            assert re.search(r"@[0-9a-f]{40}", line), line
    warm = (root / "telegram-game-keep-warm.yml").read_text(encoding="utf-8")
    assert "schedule:" in warm and "workflow_dispatch:" in warm
    assert "/healthz" in warm
    assert "/api/" not in warm and "/readyz" not in warm  # cheap, no database, no player data
    assert "permissions: {}" in warm

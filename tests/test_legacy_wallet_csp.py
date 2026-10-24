import re
from pathlib import Path

import app as app_module

TEMPLATE = Path(__file__).resolve().parent.parent / "templates" / "wallet.html"


def _directives(header):
    return {
        part.split()[0]: part.split()[1:]
        for part in (p.strip() for p in header.split(";"))
        if part
    }


def test_legacy_wallet_page_sends_strict_csp():
    response = app_module.app.test_client().get("/wallet")
    assert response.status_code == 200
    d = _directives(response.headers["Content-Security-Policy"])
    assert d["default-src"] == ["'none'"]
    assert d["script-src"] == ["'self'"]
    assert d["style-src"] == ["'self'"]
    assert d["connect-src"] == ["'self'"]
    assert d["object-src"] == ["'none'"]
    assert d["base-uri"] == ["'none'"]
    assert d["frame-ancestors"] == ["'none'"]
    joined = " ".join(sum(d.values(), []))
    for weak in ("'unsafe-inline'", "'unsafe-eval'", "*", "data:", "http:", "https:"):
        assert weak not in joined.split()
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Cache-Control"] == "no-store"


def test_legacy_wallet_template_has_no_inline_code():
    html = TEMPLATE.read_text(encoding="utf-8")
    assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html), "inline <script> blocked by CSP"
    assert "<style" not in html
    assert not re.search(r"\son\w+\s*=", html, re.I), "inline event handler blocked by CSP"
    assert not re.search(r"\sstyle\s*=", html, re.I)


def test_legacy_wallet_static_assets_are_served():
    client = app_module.app.test_client()
    html = TEMPLATE.read_text(encoding="utf-8")
    for src in re.findall(r'(?:src|href)="(/static/[^"]+)"', html):
        assert client.get(src).status_code == 200, src
    js = client.get("/static/legacy-wallet/wallet.js").get_data(as_text=True)
    for action in re.findall(r'data-action="(\w+)"', html):
        assert re.search(rf"function {action}\b", js), action


def test_legacy_wallet_shows_retirement_banner_pointing_to_pwa():
    response = app_module.app.test_client().get("/wallet")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    banner = re.search(r'<div class="retire-banner" role="note" data-retire-banner>(.*?)</div>', html, re.S)
    assert banner, "retirement banner missing"
    text = banner.group(1)
    assert 'href="https://zyronchain.com/app/"' in text
    assert "deprecated" in text and "retired after a notice period" in text
    assert html.index("data-retire-banner") < html.index("Create Wallet"), "banner is above the wallet flows"
    css = app_module.app.test_client().get("/static/legacy-wallet/wallet.css").get_data(as_text=True)
    assert ".retire-banner" in css

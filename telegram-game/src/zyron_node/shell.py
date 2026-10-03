"""Render the Mini App shell (index.html) for both hosting layouts.

* Same-origin: the API serves ``/`` and ``/assets/*`` itself (``api_base=""``). Kept so older Play Zyron links
  that point at the API host keep working.
* Decoupled: ``scripts/build_static.py`` writes the shell to an always-on static host (GitHub Pages). The page
  paints at once and calls the API at ``api_base``; the API answers CORS only for the configured static origin.
"""

from __future__ import annotations

from html import escape
from pathlib import Path
from urllib.parse import urlsplit

from zyron_node.buildinfo import CLIENT_BUILD, SHELL_ID

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
STATIC_ASSETS = (
    "app.js",
    "boot.js",
    "boot-recover.js",
    "wake.js",
    "blocks.js",
    "styles.css",
    "logo.png",
    "points-mark-52.png",
    "points-mark-104.png",
    "points-mark-156.png",
)


def static_csp(api_origin: str) -> str:
    """CSP for the static host (sent as a meta tag; GitHub Pages cannot set headers).

    ``frame-ancestors`` is not honoured in a meta tag; the static shell holds no secrets and every API call is
    authenticated server-side with Telegram initData, so Telegram Web may frame it.
    """
    return (
        "default-src 'none'; "
        "script-src 'self' https://telegram.org; "
        "style-src 'self'; "
        "img-src 'self' data:; "
        f"connect-src {api_origin}; "
        "base-uri 'none'; "
        "form-action 'none'; "
        "manifest-src 'self'"
    )


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        return ""
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme}://{parts.hostname.lower()}{port}"


def render_index(api_base: str = "", asset_base: str = "/assets/") -> str:
    html = (FRONTEND / "index.html").read_text(encoding="utf-8")
    extra = ""
    if api_base:
        api_origin = origin_of(api_base)
        if not api_origin or api_origin != api_base.rstrip("/"):
            raise ValueError("api_base must be a bare http(s) origin")
        extra = (
            f'  <meta http-equiv="Content-Security-Policy" content="{escape(static_csp(api_origin), quote=False)}" />\n'
            '  <meta name="referrer" content="no-referrer" />'
        )
    return (
        html.replace("{{EXTRA_HEAD}}", extra)
        .replace("{{CLIENT_BUILD}}", CLIENT_BUILD)
        .replace("{{SHELL_ID}}", SHELL_ID)
        .replace("{{API_BASE}}", escape(api_base.rstrip("/")))
        .replace("{{ASSET_BASE}}", escape(asset_base))
    )

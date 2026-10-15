"""Halloween 2026 seasonal theme in the Mini App and its cosmetic-only badge."""

import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

from tests.test_api import auth
from zyron_node import game
from zyron_node.buildinfo import CLIENT_BUILD
from zyron_node.shell import STATIC_ASSETS

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"
INSIDE = datetime(2026, 10, 20, 15, 0, tzinfo=timezone.utc)


def test_badge_window_matches_new_york_dates():
    assert game.SEASON_BADGE_START.isoformat() == "2026-10-15T04:00:00+00:00"
    assert game.SEASON_BADGE_END.isoformat() == "2026-11-01T04:00:00+00:00"
    assert not game.season_badge_open(datetime(2026, 10, 15, 3, 59, 59, tzinfo=timezone.utc))
    assert game.season_badge_open(game.SEASON_BADGE_START)
    assert game.season_badge_open(datetime(2026, 11, 1, 3, 59, 59, tzinfo=timezone.utc))
    assert not game.season_badge_open(game.SEASON_BADGE_END)


def test_badge_not_granted_before_window(client):
    me = client.get("/api/me", headers=auth(9101, when=datetime(2026, 10, 14, 12, tzinfo=timezone.utc))).json()["player"]
    assert "halloween_2026" not in me["cosmetics"]


def test_badge_granted_once_inside_window_with_zero_points(client):
    first = client.get("/api/me", headers=auth(9102, when=INSIDE)).json()["player"]
    assert "halloween_2026" in first["cosmetics"]
    again = client.get("/api/me", headers=auth(9102, when=INSIDE)).json()["player"]
    assert again["cosmetics"].count("halloween_2026") == 1
    assert again["points"] == first["points"] == 0
    assert "halloween_2026" not in {item.id for item in game.COSMETICS}


def test_badge_not_granted_after_window(client):
    me = client.get("/api/me", headers=auth(9103, when=datetime(2026, 11, 1, 4, tzinfo=timezone.utc))).json()["player"]
    assert "halloween_2026" not in me["cosmetics"]


def test_season_script_is_served_and_loaded_before_app(client):
    assert "season.js" in STATIC_ASSETS
    index = (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert '<script src="{{ASSET_BASE}}season.js?v={{CLIENT_BUILD}}" defer></script>' in index
    assert index.index("}}season.js") < index.index("}}app.js")
    served = client.get(f"/assets/season.js?v={CLIENT_BUILD}")
    assert served.status_code == 200
    assert served.text == (FRONTEND / "season.js").read_text(encoding="utf-8")


def test_skins_hats_and_reduced_motion_css():
    css = (FRONTEND / "styles.css").read_text(encoding="utf-8")
    assert ".builder-hat { display: none; }" in css
    assert ".season-halloween .builder-hat { display: inline; }" in css
    assert ".season-halloween .chain-art .face-top" in css
    assert ".season-layer { position: fixed; inset: 0; pointer-events: none;" in css
    assert "@media (prefers-reduced-motion: reduce) { .season-layer { display: none; } }" in css


def test_season_gating_in_node():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    script = (
        "const S=require('./frontend/season.js');const a=(s)=>Date.parse(s);const ok="
        "!S.active(a('2026-10-14T23:59:59-04:00'),'')&&S.active(a('2026-10-15T00:00:00-04:00'),'')"
        "&&!S.active(a('2026-11-01T00:00:00-04:00'),'')&&S.active(a('2026-06-01T00:00:00Z'),'?season=halloween')"
        "&&!S.active(a('2026-10-20T00:00:00Z'),'?season=off')&&S.reducedMotion({matchMedia:()=>({matches:true})});"
        "process.exit(ok?0:1)"
    )
    assert subprocess.run([node, "-e", script], check=False).returncode == 0

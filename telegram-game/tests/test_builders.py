"""Builders beside the orbit ring (frontend/builders.js) that carve the chain's blocks."""

import re
import shutil
import subprocess
from pathlib import Path

from zyron_node.buildinfo import CLIENT_BUILD
from zyron_node.shell import STATIC_ASSETS

FRONTEND = Path("frontend")
RETIRED_WORDING = re.compile(r"\bmin(?:er|ing)s?\b", re.IGNORECASE)


def _block(css, start):
    i = css.index(start)
    depth, j = 0, css.index("{", i)
    for k in range(j, len(css)):
        if css[k] == "{":
            depth += 1
        elif css[k] == "}":
            depth -= 1
            if depth == 0:
                return css[i : k + 1]
    raise AssertionError(start)


def test_builders_module():
    node = shutil.which("node")
    assert node, "node is required to test the builders"
    result = subprocess.run([node, "tests/builders.test.js"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    assert "builders ok" in result.stdout
    checked = subprocess.run([node, "--check", "frontend/builders.js"], check=False, capture_output=True, text=True)
    assert checked.returncode == 0, checked.stderr


def test_builders_wording_uses_builders_only():
    # ZyronChain retired the old wording: the characters are builders in UI text, labels, code and tests.
    files = [*FRONTEND.glob("*.js"), *FRONTEND.glob("*.css"), *FRONTEND.glob("*.html"), *Path("tests").glob("*builders*")]
    for path in files:
        assert not RETIRED_WORDING.search(path.read_text(encoding="utf-8")), path
    builders_js = (FRONTEND / "builders.js").read_text(encoding="utf-8")
    assert '"Builders carving blocks"' in builders_js


def test_builders_are_wired_into_the_node_visual():
    app = (FRONTEND / "app.js").read_text(encoding="utf-8")
    assert "[nodeArt(energy.current), buildersLayer(), chainTrack()]" in app
    assert '"data-builders": "1"' in app and '"data-builders-state"' in app
    assert 'role: "img", "aria-label": window.ZyronBuilders.labelFor("idle")' in app
    assert 'layer.setAttribute("aria-label", window.ZyronBuilders.labelFor(next));' in app
    assert 'syncBuilders(visual.querySelector("[data-builders]"))' in app
    assert "running: !!state.running" in app
    # A real completed cycle sends a carved block to the chain head, then the chain snaps it on.
    carve = app[app.index("function carveBlock()") :]
    carve = carve[: carve.index("\n  }\n")]
    assert "builders.flightPath(builders.rockPoint(state.builderTurn), trackDegrees(track)" in carve
    assert 'prefers-reduced-motion: reduce' in carve and 'document.visibilityState === "hidden"' in carve
    assert 'fill: "forwards"' in carve  # never flashes at the layer origin before it is removed
    assert carve.index("block.remove();") < carve.rindex("snapChain();")
    assert '"style"' not in app


def test_builders_animate_only_while_running():
    css = (FRONTEND / "styles.css").read_text(encoding="utf-8")
    lines = [line for line in css.splitlines() if "builder" in line and re.search(r"\banimation\s*:", line)]
    assert lines
    for line in lines:
        assert '[data-builders-state="run"]' in line, line
    assert '.builders[data-builders-state="hidden"] { display: none; }' in css
    # Idle: pickaxe down. Out of energy: slumped and dimmed. Running without motion: pickaxe raised.
    assert ".builder-arm { transform: rotate(80deg); }" in css
    assert '.builders[data-builders-state="rest"] .builder-body { transform: rotate(12deg); }' in css
    assert '.builders[data-builders-state="rest"] .builders-art { opacity: 0.5;' in css
    assert '.builders[data-builders-state="run"] .builder-arm { transform: rotate(-40deg); animation: builder-swing' in css
    assert ".builder-pop,\n.builder-chip { opacity: 0; transform: scale(0); }" in css
    for name in ("builder-swing", "builder-lean", "builder-pop", "builder-chip-1", "builder-chip-2", "builder-chip-3"):
        props = set(re.findall(r"([a-z-]+)\s*:", _block(css, "@keyframes " + name)))
        assert props <= {"transform", "opacity"} and "transform" in props, (name, props)
    assert "html.is-hidden .builders *" in css
    assert "animation: none !important" in _block(css, "@media (prefers-reduced-motion: reduce)")
    # Positioned overlay: no effect on layout.
    assert ".builders {\n  position: absolute;" in css


def test_builders_ship_in_the_static_shell(client):
    assert "builders.js" in STATIC_ASSETS
    assert CLIENT_BUILD not in ("20261003.1", "20261003.2", "20261003.3")
    index = (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert '<script src="{{ASSET_BASE}}builders.js?v={{CLIENT_BUILD}}" defer></script>' in index
    assert index.index("}}blocks.js") < index.index("}}builders.js") < index.index("}}app.js")
    served = client.get(f"/assets/builders.js?v={CLIENT_BUILD}")
    assert served.status_code == 200
    assert served.text == (FRONTEND / "builders.js").read_text(encoding="utf-8")

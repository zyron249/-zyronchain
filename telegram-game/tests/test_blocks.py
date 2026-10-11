"""Block chain on the home screen's outer orbit ring (frontend/blocks.js)."""

import re
import shutil
import subprocess
from pathlib import Path

from zyron_node.buildinfo import CLIENT_BUILD
from zyron_node.shell import STATIC_ASSETS, static_csp

FRONTEND = Path("frontend")


def _css():
    return (FRONTEND / "styles.css").read_text(encoding="utf-8")


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


def test_blocks_module_states_and_structure():
    node = shutil.which("node")
    assert node, "node is required to test the block chain"
    result = subprocess.run([node, "tests/blocks.test.js"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    assert "blocks ok" in result.stdout
    checked = subprocess.run([node, "--check", "frontend/blocks.js"], check=False, capture_output=True, text=True)
    assert checked.returncode == 0, checked.stderr


def test_wolf_is_gone():
    assert not (FRONTEND / "wolf.js").exists()
    assert "wolf.js" not in STATIC_ASSETS
    for name in ("app.js", "styles.css", "index.html"):
        text = (FRONTEND / name).read_text(encoding="utf-8")
        assert "ZyronWolf" not in text and "wolf-track" not in text and "wolf.js" not in text, name


def test_chain_element_is_rendered_on_the_node_visual():
    app = (FRONTEND / "app.js").read_text(encoding="utf-8")
    assert "[nodeArt(energy.current), buildersLayer(), chainTrack()]" in app
    assert '"data-chain": "1"' in app and '"data-chain-state"' in app
    assert 'syncChain(visual.querySelector("[data-chain]"))' in app
    assert "window.ZyronBlocks.stateFor(" in app
    assert "running: !!state.running" in app
    assert 'state.wake.phase === "waking"' in app
    assert "state.chainEpoch = Date.now();" in app
    # One timeline for the lap and the upright counter-rotation, set through CSSOM (style-src 'self').
    assert 'track.style.setProperty("--chain-delay", window.ZyronBlocks.lapDelay(' in app
    assert '"style"' not in app
    # Each completed cycle snaps a block on (after the builders' carved block lands; see test_builders.py).
    loop = app[app.index("async function runLoop()") :]
    loop = loop[: loop.index("} finally {")]
    assert "applyCycle(res);" in loop and "carveBlock();" in loop
    assert loop.index("applyCycle(res);") < loop.index("carveBlock();")
    carve = app[app.index("function carveBlock()") :]
    carve = carve[: carve.index("\n  }\n")]
    assert carve.count("snapChain();") == 2  # immediate fallback and on landing
    assert 'track.setAttribute("data-snap", window.ZyronBlocks.nextSnap(' in app
    assert 'classList.toggle("is-hidden", document.visibilityState === "hidden")' in app
    assert 'r: String(CHAIN_RING_R)' in app


def test_chain_moves_only_while_running_and_respects_reduced_motion():
    css = _css()
    anim_lines = [line for line in css.splitlines() if "chain" in line and re.search(r"\banimation\s*:", line)]
    assert anim_lines
    for line in anim_lines:
        assert '[data-chain-state="run"]' in line, line
    assert re.search(r'\.chain-track\[data-chain-state="run"\] \{[^}]*animation: chain-lap 10s linear infinite; animation-delay: var\(--chain-delay, 0s\)', css)
    assert re.search(r'\.chain-track\[data-chain-state="run"\] \.chain-upright \{ animation: chain-upright 10s linear infinite; animation-delay: var\(--chain-delay, 0s\)', css)
    assert '.chain-track[data-chain-state="hidden"] { display: none; }' in css
    assert '.chain-track[data-chain-state="rest"] .chain-art { opacity: 0.5;' in css
    # Parked (static) transforms outside the run state: centred on the top, blocks upright, flash hidden.
    assert "transform: rotate(42.5deg);" in _block(css, ".chain-track {")
    assert ".chain-upright { transform: rotate(-42.5deg); }" in css
    assert ".chain-flash { transform: scale(0); }" in css
    # Transform-only keyframes; lap and counter-rotation cancel exactly.
    for name in ("chain-lap", "chain-upright", "chain-pop-a", "chain-pop-b", "chain-flash-a", "chain-flash-b"):
        body = _block(css, "@keyframes " + name)
        assert set(re.findall(r"([a-z-]+)\s*:", body)) == {"transform"}, name
    assert _block(css, "@keyframes chain-pop-a").replace("-a", "") == _block(css, "@keyframes chain-pop-b").replace("-b", "")
    assert "html.is-hidden .chain-track *" in css and "animation-play-state: paused" in css
    reduced = _block(css, "@media (prefers-reduced-motion: reduce)")
    assert "animation: none !important" in reduced
    # Same layout box as before: fixed node visual, absolutely positioned overlay.
    assert ".node-visual { width: min(168px, 44vw); margin: 14px auto 24px; position: relative; }" in css
    assert ".chain-track {\n  position: absolute;\n  inset: 0;" in css


def test_chain_ships_in_the_static_shell_and_busts_the_cache(client, tmp_path):
    assert "blocks.js" in STATIC_ASSETS
    assert CLIENT_BUILD not in ("20261003.1", "20261003.2")
    index = (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert '<script src="{{ASSET_BASE}}blocks.js?v={{CLIENT_BUILD}}" defer></script>' in index
    assert index.index("}}blocks.js") < index.index("}}app.js")
    served = client.get(f"/assets/blocks.js?v={CLIENT_BUILD}")
    assert served.status_code == 200
    assert served.text == (FRONTEND / "blocks.js").read_text(encoding="utf-8")
    assert client.get(f"/assets/wolf.js?v={CLIENT_BUILD}").status_code == 404
    out = tmp_path / "site"
    subprocess.run(["python3", "scripts/build_static.py", "--out", str(out), "--api", "https://zyron-node.onrender.com"], check=True, capture_output=True)
    assert (out / "assets" / "blocks.js").read_bytes() == (FRONTEND / "blocks.js").read_bytes()
    assert not (out / "assets" / "wolf.js").exists()
    built = (out / "index.html").read_text(encoding="utf-8")
    assert f"blocks.js?v={CLIENT_BUILD}" in built
    assert "unsafe-inline" not in built and "unsafe-inline" not in static_csp("https://zyron-node.onrender.com")

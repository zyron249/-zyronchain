"""Running brand wolf on the home screen's outer orbit ring (frontend/wolf.js)."""

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


def test_wolf_module_states_and_structure():
    node = shutil.which("node")
    assert node, "node is required to test the running wolf"
    result = subprocess.run([node, "tests/wolf.test.js"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    assert "wolf ok" in result.stdout
    checked = subprocess.run([node, "--check", "frontend/wolf.js"], check=False, capture_output=True, text=True)
    assert checked.returncode == 0, checked.stderr


def test_wolf_element_is_rendered_on_the_node_visual():
    app = (FRONTEND / "app.js").read_text(encoding="utf-8")
    # The element exists in the home node visual and its state follows every patch.
    assert '[nodeArt(energy.current), wolfTrack()]' in app
    assert '"data-wolf": "1"' in app and '"data-wolf-state"' in app
    assert 'syncWolf(visual.querySelector("[data-wolf]"))' in app
    assert "window.ZyronWolf.stateFor(" in app
    assert "running: !!state.running" in app
    assert 'state.wake.phase === "waking"' in app
    assert "state.wolfEpoch = Date.now();" in app
    # Lap delay goes through CSSOM (style-src 'self' forbids inline style attributes).
    assert "track.style.animationDelay = window.ZyronWolf.lapDelay(" in app
    assert '"style"' not in app
    # Pause decorative motion in the background.
    assert 'classList.toggle("is-hidden", document.visibilityState === "hidden")' in app
    # The old orbiting dots are gone; the outer ring is the wolf's track.
    assert 'r: "5", fill: "#4fd8fb"' not in app
    assert 'r: String(WOLF_RING_R)' in app


def test_wolf_only_runs_while_running_and_respects_reduced_motion():
    css = _css()
    # Every wolf animation is scoped to the RUNNING state; idle and rest have none.
    wolf_anim_lines = [line for line in css.splitlines() if "wolf" in line and re.search(r"\banimation\s*:", line)]
    assert wolf_anim_lines
    for line in wolf_anim_lines:
        assert '[data-wolf-state="run"]' in line, line
    lap = re.search(r'\.wolf-track\[data-wolf-state="run"\] \{[^}]*animation: wolf-lap (\d+(?:\.\d+)?)s linear infinite', css)
    assert lap and 8 <= float(lap.group(1)) <= 12
    assert '.wolf-track[data-wolf-state="hidden"] { display: none; }' in css
    assert '[data-wolf-state="idle"]' in css and '[data-wolf-state="rest"]' in css
    # Transform-only keyframes (GPU-friendly, no layout).
    for name in ("wolf-lap", "wolf-fu", "wolf-fl", "wolf-hu", "wolf-hl", "wolf-bob", "wolf-tail"):
        body = _block(css, "@keyframes " + name)
        props = set(re.findall(r"([a-z-]+)\s*:", body))
        assert props == {"transform"}, (name, props)
    # Paused while hidden.
    assert "html.is-hidden .wolf-track *" in css and "animation-play-state: paused" in css
    # prefers-reduced-motion: no animation at all, a static mid-stride pose while RUNNING.
    reduced = _block(css, "@media (prefers-reduced-motion: reduce)")
    assert "animation: none !important" in reduced
    assert '.wolf-track[data-wolf-state="run"] .wolf-fu.wolf-n { transform: rotate(' in reduced
    # The ring visual has a fixed box, so state changes never shift layout.
    assert re.search(r"\.node-visual \{ width: min\(\d+px, \d+vw\); margin: [^;]+; position: relative; \}", css)
    assert ".wolf-track {\n  position: absolute;\n  inset: 0;" in css


def test_wolf_ships_in_the_static_shell_and_busts_the_cache(client, tmp_path):
    assert "wolf.js" in STATIC_ASSETS
    assert CLIENT_BUILD != "20261003.1"
    index = (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert '<script src="{{ASSET_BASE}}wolf.js?v={{CLIENT_BUILD}}" defer></script>' in index
    assert index.index("}}wolf.js") < index.index("}}app.js")
    served = client.get(f"/assets/wolf.js?v={CLIENT_BUILD}")
    assert served.status_code == 200
    assert served.text == (FRONTEND / "wolf.js").read_text(encoding="utf-8")
    out = tmp_path / "site"
    subprocess.run(["python3", "scripts/build_static.py", "--out", str(out), "--api", "https://zyron-node.onrender.com"], check=True, capture_output=True)
    assert (out / "assets" / "wolf.js").read_bytes() == (FRONTEND / "wolf.js").read_bytes()
    built = (out / "index.html").read_text(encoding="utf-8")
    assert f"wolf.js?v={CLIENT_BUILD}" in built
    assert "unsafe-inline" not in built and "unsafe-inline" not in static_csp("https://zyron-node.onrender.com")

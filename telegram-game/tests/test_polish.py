"""Premium node presentation: evolution, chest ceremony, level-up, mute, podium."""

import shutil
import subprocess
from pathlib import Path

from zyron_node.buildinfo import CLIENT_BUILD
from zyron_node.shell import STATIC_ASSETS

FRONTEND = Path("frontend")


def test_polish_module():
    node = shutil.which("node")
    assert node, "node is required"
    result = subprocess.run([node, "tests/polish.test.js"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "polish ok" in result.stdout
    checked = subprocess.run([node, "--check", "frontend/polish.js"], check=False, capture_output=True, text=True)
    assert checked.returncode == 0, checked.stderr
    checked_app = subprocess.run([node, "--check", "frontend/app.js"], check=False, capture_output=True, text=True)
    assert checked_app.returncode == 0, checked_app.stderr


def test_polish_ships_in_the_shell(client):
    assert "polish.js" in STATIC_ASSETS
    index = (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert "polish.js?v={{CLIENT_BUILD}}" in index
    assert index.index("}}polish.js") < index.index("}}app.js")
    served = client.get(f"/assets/polish.js?v={CLIENT_BUILD}")
    assert served.status_code == 200
    assert served.text == (FRONTEND / "polish.js").read_text(encoding="utf-8")
    page = client.get("/")
    assert page.status_code == 200
    assert "polish.js" in page.text

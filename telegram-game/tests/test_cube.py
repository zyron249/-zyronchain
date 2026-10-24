"""CSS 3D node cube and local-time sky."""

import shutil
import subprocess
from pathlib import Path

from zyron_node.buildinfo import CLIENT_BUILD
from zyron_node.shell import STATIC_ASSETS

FRONTEND = Path("frontend")


def test_cube_and_sky_modules():
    node = shutil.which("node")
    assert node
    result = subprocess.run([node, "tests/cube.test.js"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "cube ok" in result.stdout
    for name in ("frontend/cube.js", "frontend/daynight.js", "frontend/app.js"):
        checked = subprocess.run([node, "--check", name], check=False, capture_output=True, text=True)
        assert checked.returncode == 0, checked.stderr


def test_cube_ships(client):
    assert "cube.js" in STATIC_ASSETS
    assert "daynight.js" in STATIC_ASSETS
    index = (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert index.index("}}cube.js") < index.index("}}app.js")
    assert index.index("}}daynight.js") < index.index("}}app.js")
    served = client.get(f"/assets/cube.js?v={CLIENT_BUILD}")
    assert served.status_code == 200
    assert "three.js" not in served.text
    page = client.get("/")
    assert "cube.js" in page.text and "daynight.js" in page.text
    app = (FRONTEND / "app.js").read_text(encoding="utf-8")
    assert "ZyronCube.build" in app
    assert "ZyronSky.apply" in app
    assert '"style"' not in app

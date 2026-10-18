"""390px smoke for cosmetic builder appearance."""

import os
import shutil
import socket
import subprocess
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FRONTEND = Path("frontend").resolve()


def _chrome():
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    env = os.environ.get("CHROME_PATH", "")
    return env if env and Path(env).exists() else ""


def _dump(chrome, url, shot, profile):
    cmd = [
        chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
        "--no-first-run", "--window-size=390,844", f"--user-data-dir={profile}",
        f"--screenshot={shot}", "--dump-dom", url,
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    chunks = []
    deadline = time.time() + 12
    while time.time() < deadline:
        line = proc.stdout.readline()
        if line:
            chunks.append(line)
            if "</html>" in "".join(chunks):
                break
        elif proc.poll() is not None:
            break
        else:
            time.sleep(0.05)
    shot_deadline = time.time() + 4
    while time.time() < shot_deadline:
        if Path(shot).exists() and Path(shot).stat().st_size > 1000:
            break
        time.sleep(0.1)
    proc.kill()
    try:
        rest, _ = proc.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        rest = ""
    out = "".join(chunks) + (rest or "")
    assert Path(shot).stat().st_size > 1000
    return out


def test_phase3_mobile_smoke(tmp_path):
    chrome = _chrome()
    assert chrome
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    handler = partial(SimpleHTTPRequestHandler, directory=str(FRONTEND))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        html = _dump(
            chrome,
            f"http://127.0.0.1:{port}/preview-phase3.html",
            tmp_path / "look.png",
            tmp_path / "prof",
        )
        assert 'data-mask="wolf"' in html
        assert 'data-helmet="crest"' in html
        assert 'data-pick="gold"' in html
        assert "builder-mask" in html
        assert "miner" not in html.lower()
    finally:
        server.shutdown()

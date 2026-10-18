"""390px smoke for the node cube and local-time sky."""

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
        path = shutil.which(name)
        if path:
            return path
    env = os.environ.get("CHROME_PATH", "")
    return env if env and Path(env).exists() else ""


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _dump(chrome, url, shot, profile):
    cmd = [
        chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
        "--no-first-run", "--disable-extensions", "--window-size=390,844",
        f"--user-data-dir={profile}", f"--screenshot={shot}", "--dump-dom", url,
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
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
    proc.kill()
    try:
        rest, _ = proc.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        rest = ""
    if rest:
        chunks.append(rest)
    out = "".join(chunks)
    assert "<html" in out
    assert Path(shot).exists() and Path(shot).stat().st_size > 1000
    return out


def test_phase2_mobile_smoke(tmp_path):
    chrome = _chrome()
    assert chrome
    port = _free_port()
    handler = partial(SimpleHTTPRequestHandler, directory=str(FRONTEND))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{port}/preview-phase2.html"
        night = _dump(chrome, base + "?hour=23&level=11", tmp_path / "night.png", tmp_path / "p1")
        assert 'data-sky="night"' in night
        assert 'data-layers="6"' in night
        assert "rotateX" in night
        assert "miner" not in night.lower()
        day = _dump(chrome, base + "?hour=12&level=1", tmp_path / "day.png", tmp_path / "p2")
        assert 'data-sky="day"' in day
        assert 'data-layers="1"' in day
    finally:
        server.shutdown()

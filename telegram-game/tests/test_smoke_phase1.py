"""Headless mobile smoke for the phase-1 presentation at a 390px viewport."""

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
    if env and Path(env).exists():
        return env
    return ""


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _serve():
    port = _free_port()
    handler = partial(SimpleHTTPRequestHandler, directory=str(FRONTEND))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


def _dump(chrome, url, shot, profile):
    # Headless Chrome prints the DOM and then can linger on the DevTools pipe.
    # The smoke treats a finished dump as success and stops the process.
    cmd = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-extensions",
        "--window-size=390,844",
        f"--user-data-dir={profile}",
        f"--screenshot={shot}",
        "--dump-dom",
        url,
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    chunks = []
    deadline = time.time() + 12
    while time.time() < deadline:
        line = proc.stdout.readline()
        if line:
            chunks.append(line)
            if "</html>" in line or (chunks and "</html>" in "".join(chunks)):
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
    if rest:
        chunks.append(rest)
    out = "".join(chunks)
    assert Path(shot).exists() and Path(shot).stat().st_size > 1000, "missing screenshot"
    return out


def test_phase1_mobile_smoke(tmp_path):
    chrome = _chrome()
    assert chrome, "a headless Chrome binary is required for the 390px smoke"
    server, port = _serve()
    try:
        base = f"http://127.0.0.1:{port}/preview-phase1.html"
        node = _dump(chrome, base + "?shot=node", tmp_path / "node.png", tmp_path / "prof-node")
        assert 'data-evo="legendary"' in node
        assert "data-sparks" in node
        assert "data-builders-state=\"run\"" in node
        assert "data-chain-state=\"run\"" in node
        assert "Legendary node" in node
        assert "Sound on" in node
        assert "miner" not in node.lower()
        chest = _dump(chrome, base + "?shot=chest", tmp_path / "chest.png", tmp_path / "prof-chest")
        assert "is-gold" in chest
        assert "Rare supply" in chest
        level = _dump(chrome, base + "?shot=level", tmp_path / "level.png", tmp_path / "prof-level")
        assert "LEVEL UP" in level
        assert "Gold node" in level
        board = _dump(chrome, base + "?shot=board", tmp_path / "board.png", tmp_path / "prof-board")
        assert "podium p1" in board and "podium p2" in board and "podium p3" in board
        assert "podium p4" not in board
    finally:
        server.shutdown()
        time.sleep(0.05)

#!/usr/bin/env python3
"""Build the always-on static Play Zyron shell (deployed to GitHub Pages by telegram-game-pages.yml).

    python telegram-game/scripts/build_static.py --out _site --api https://zyron-node.onrender.com

The output is index.html (API origin and a strict CSP baked in), assets/* (versioned with CLIENT_BUILD via the
query string) and .nojekyll. The bot points the Play Zyron button at this site; the page paints immediately and
waits for the API with a visible "Waking server…" state while the free API host cold-starts.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from zyron_node.buildinfo import CLIENT_BUILD  # noqa: E402
from zyron_node.shell import FRONTEND, STATIC_ASSETS, origin_of, render_index  # noqa: E402

DEFAULT_API = "https://zyron-node.onrender.com"


def build(out: Path, api: str) -> list[str]:
    api = api.rstrip("/")
    if origin_of(api) != api:
        raise SystemExit("--api must be a bare origin such as https://zyron-node.onrender.com")
    if not api.startswith("https://") and not api.startswith(("http://127.0.0.1", "http://localhost")):
        raise SystemExit("--api must be https (http is allowed only for 127.0.0.1/localhost tests)")
    if out.exists():
        shutil.rmtree(out)
    (out / "assets").mkdir(parents=True)
    written = []
    (out / "index.html").write_text(render_index(api_base=api, asset_base="./assets/"), encoding="utf-8")
    written.append("index.html")
    for name in STATIC_ASSETS:
        shutil.copyfile(FRONTEND / name, out / "assets" / name)
        written.append("assets/" + name)
    (out / ".nojekyll").write_text("", encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    (out / "build.txt").write_text(f"client_build={CLIENT_BUILD}\napi={api}\n", encoding="utf-8")
    written += [".nojekyll", "robots.txt", "build.txt"]
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="_site")
    parser.add_argument("--api", default=DEFAULT_API)
    args = parser.parse_args()
    files = build(Path(args.out), args.api)
    print(f"static-shell-built build={CLIENT_BUILD} api={args.api.rstrip('/')} files={len(files)}")


if __name__ == "__main__":
    main()

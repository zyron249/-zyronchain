#!/usr/bin/env python3
"""ZYRON CHAIN brand asset pipeline (gold Z coin mark).

Every website / PWA / Telegram Mini App brand asset is drawn from the vector master
tools/brand/source/zyron-mark.svg (geometry mirrored in MARK below) with Pillow only, no network:

    python3 tools/brand/build-brand.py [--extra-out DIR]

--extra-out also writes a manual-upload kit (profile photo 640, bot avatar 512, transparent marks,
horizontal logo, 1200x630 OG image). Re-run `node tools/pwa-wallet/stamp-app.mjs` afterwards so the
PWA service worker / SRI pins stay current.
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SRC = Path(__file__).resolve().parent / "source"
WEB = ROOT / "website"
BRAND = WEB / "brand"
APP_ICONS = WEB / "app" / "icons"
GAME = ROOT / "telegram-game" / "frontend"

# Palette (see tools/brand/README.md)
VOID = (10, 10, 11)        # #0a0a0b page background
PANEL = (20, 20, 22)       # #141416
GOLD = (249, 183, 0)       # #f9b700 brand gold
WHITE = (255, 255, 255)

# Mark geometry on a 1024 grid (same as source/zyron-mark.svg).
CIRCLE = (512, 512, 434)
DX, DY = 4, 2
Z_POLY = [(322, 283), (770, 283), (457, 625), (770, 625), (696, 707), (245, 707), (562, 371), (259, 371)]
BARS = [(414, 193, 480, 283), (526, 193, 592, 283), (414, 707, 480, 807), (526, 707, 592, 807)]

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/sand-box/google/Poppins/Poppins-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def font(px: int) -> ImageFont.FreeTypeFont:
    for f in FONT_CANDIDATES:
        if Path(f).exists():
            return ImageFont.truetype(f, px)
    return ImageFont.load_default(px)


def mark(size: int, coin: bool = True, glyph=WHITE, fill=GOLD) -> Image.Image:
    """Transparent RGBA mark (gold coin + white Z). coin=False draws only the glyph (in `glyph`)."""
    ss = 4
    S = size * ss
    k = S / 1024
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, cy, r = CIRCLE
    if coin:
        d.ellipse(((cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k), fill=fill + (255,))
    g = glyph + (255,)
    d.polygon([((x + DX) * k, (y + DY) * k) for x, y in Z_POLY], fill=g)
    for x0, y0, x1, y1 in BARS:
        d.rectangle(((x0 + DX) * k, (y0 + DY) * k, (x1 + DX) * k, (y1 + DY) * k), fill=g)
    return im.resize((size, size), Image.LANCZOS)


def glow_bg(w: int, h: int, cx: float, cy: float, radius: float, strength: float = 0.28) -> Image.Image:
    """Near-black background with a soft warm gold glow centred at (cx, cy)."""
    bg = Image.new("RGB", (w, h), VOID)
    glow = Image.new("L", (w, h), 0)
    ImageDraw.Draw(glow).ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=int(255 * strength))
    glow = glow.filter(ImageFilter.GaussianBlur(radius * 0.55))
    return Image.composite(Image.new("RGB", (w, h), (120, 86, 0)), bg, glow)


def icon(size: int, scale: float, bg: Image.Image | None = None, rounded: float = 0.0) -> Image.Image:
    canvas = (bg or Image.new("RGB", (size, size), VOID)).convert("RGBA")
    m = round(size * scale)
    canvas.alpha_composite(mark(m), ((size - m) // 2, (size - m) // 2))
    if rounded:
        mask = Image.new("L", (size * 4, size * 4), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=int(size * 4 * rounded), fill=255)
        canvas.putalpha(mask.resize((size, size), Image.LANCZOS))
    return canvas


def save_png(img: Image.Image, path: Path, opaque: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    (img.convert("RGB") if opaque else img).save(path, "PNG", optimize=True)


def save_web(img: Image.Image, stem: Path, jpg: bool = True, q: int = 82) -> None:
    stem.parent.mkdir(parents=True, exist_ok=True)
    rgb = img.convert("RGB")
    rgb.save(stem.with_suffix(".webp"), "WEBP", quality=q, method=6)
    if jpg:
        rgb.save(stem.with_suffix(".jpg"), "JPEG", quality=q + 2, optimize=True, progressive=True, subsampling=0)


def wordmark(height: int) -> Image.Image:
    """'ZYRON' white + 'CHAIN' gold on transparent."""
    f = font(int(height * 0.82))
    gap = int(height * 0.28)
    w1 = f.getlength("ZYRON")
    w2 = f.getlength("CHAIN")
    W = int(w1 + gap + w2) + 4
    im = Image.new("RGBA", (W, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    bbox = f.getbbox("ZYRON")
    y = (height - (bbox[3] - bbox[1])) // 2 - bbox[1]
    d.text((0, y), "ZYRON", font=f, fill=WHITE + (255,))
    d.text((w1 + gap, y), "CHAIN", font=f, fill=GOLD + (255,))
    return im


def banner(w: int, h: int, narrow: bool = False) -> Image.Image:
    """Hero art: wordmark on the left, gold coin on the right, warm glow, subtle grid."""
    m = int(h * (0.62 if narrow else 0.70 if w / h > 2.4 else 0.58))
    mx = int(w * (0.80 if narrow else 0.70 if w / h > 2.4 else 0.75)) - m // 2
    my = (h - m) // 2 + (int(h * 0.04) if narrow else 0)
    bg = glow_bg(w, h, mx + m / 2, my + m / 2, m * 0.95, 0.32)
    d = ImageDraw.Draw(bg)
    step = max(28, w // 40)
    for x in range(0, w, step):
        d.line((x, 0, x, h), fill=(22, 21, 18))
    for y in range(0, h, step):
        d.line((0, y, w, y), fill=(22, 21, 18))
    bg = Image.blend(Image.new("RGB", (w, h), VOID), bg, 1.0)
    shadow = Image.new("L", (w, h), 0)
    ImageDraw.Draw(shadow).ellipse((mx, my + m * 0.04, mx + m, my + m * 1.04), fill=150)
    shadow = shadow.filter(ImageFilter.GaussianBlur(m * 0.06))
    bg = Image.composite(Image.new("RGB", (w, h), (0, 0, 0)), bg, shadow).convert("RGBA")
    bg.alpha_composite(mark(m), (mx, my))
    wm_h = int(h * (0.15 if narrow else 0.17))
    wm = wordmark(wm_h)
    tx = int(w * (0.06 if narrow else 0.10 if w / h > 2.4 else 0.07))
    max_w = mx - tx - int(w * 0.05)
    if wm.width > max_w:
        wm = wm.resize((max_w, round(wm.height * max_w / wm.width)), Image.LANCZOS)
    ty = (h - wm.height) // 2 + (int(h * 0.1) if narrow else 0)
    bg.alpha_composite(wm, (tx, ty))
    bar_y = ty + wm.height + int(h * 0.04)
    ImageDraw.Draw(bg).rectangle((tx, bar_y, tx + int(wm.width * 0.34), bar_y + max(3, h // 160)), fill=GOLD + (255,))
    return bg.convert("RGB")


def og_image() -> Image.Image:
    return banner(1200, 630)


POINTS_MARK_PX = 52  # CSS px of the largest use (balance card); exported at 1x / 2x / 3x


def game_points_marks() -> None:
    for scale in (1, 2, 3):
        px = POINTS_MARK_PX * scale
        save_png(mark(px), GAME / f"points-mark-{px}.png")


SVG_MARK = (SRC / "zyron-mark.svg")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--extra-out", type=Path, default=None)
    ap.add_argument("--points-only", action="store_true", help="only write the ZYRON NODE points marks")
    args = ap.parse_args()
    if args.points_only:
        game_points_marks()
        return

    # ---- website root (names are part of the website CI contract) ----
    save_png(mark(192), WEB / "brand-mark.png")
    save_png(mark(32), WEB / "favicon-32.png")
    save_png(mark(16), BRAND / "favicon-16.png")
    save_png(mark(48), BRAND / "favicon-48.png")
    frames = [mark(s) for s in (16, 32, 48)]
    frames[2].save(WEB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=frames[:2])
    save_png(icon(180, 0.84), WEB / "apple-touch-icon.png", opaque=True)
    save_png(icon(192, 0.84), WEB / "icon-192.png", opaque=True)
    save_png(icon(512, 0.84), BRAND / "icon-512.png", opaque=True)

    svg = SVG_MARK.read_text(encoding="utf-8")
    (WEB / "favicon.svg").write_text(svg, encoding="utf-8")
    shutil.copyfile(SVG_MARK, BRAND / "zyron-mark.svg")
    inner = svg.split("<title id=\"t\">ZyronChain</title>", 1)[1].rsplit("</svg>", 1)[0]
    (WEB / "logo.svg").write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 160" width="680" height="160" role="img" aria-labelledby="t d">
<title id="t">ZyronChain</title><desc id="d">ZYRON CHAIN gold Z mark. Verifiable Layer-1</desc>
<g transform="scale(.15625)">{inner}</g>
<text x="182" y="94" fill="#ffffff" font-family="Poppins,'Segoe UI',Arial,Helvetica,sans-serif" font-size="62" font-weight="700" letter-spacing="3">ZYRON</text>
<text x="420" y="94" fill="#f9b700" font-family="Poppins,'Segoe UI',Arial,Helvetica,sans-serif" font-size="62" font-weight="700" letter-spacing="3">CHAIN</text>
<rect x="184" y="112" width="120" height="3" fill="#f9b700"/>
<text x="184" y="140" fill="#d6d1c6" font-family="ui-monospace,Consolas,monospace" font-size="16" letter-spacing="5">VERIFIABLE LAYER-1</text>
</svg>
''', encoding="utf-8")

    # ---- header wordmark + banner + og ----
    save_png(wordmark(80), BRAND / "zyron-wordmark.png")
    for width in (2172, 1600, 1080):
        save_web(banner(width, round(width * 533 / 1600)), BRAND / f"zyron-banner-{width}", jpg=width != 2172)
    for width in (1080, 720):
        save_web(banner(width, round(width * 400 / 720), narrow=True), BRAND / f"zyron-banner-m-{width}", jpg=width == 720)
    og = og_image()
    og.save(BRAND / "og-image.jpg", "JPEG", quality=86, optimize=True, progressive=True)

    # ---- PWA wallet ----
    save_png(icon(192, 0.84), APP_ICONS / "icon-192.png", opaque=True)
    save_png(icon(512, 0.84), APP_ICONS / "icon-512.png", opaque=True)
    # Maskable: mark inside the 80% safe zone.
    save_png(icon(192, 0.66, bg=glow_bg(192, 192, 96, 96, 110)), APP_ICONS / "maskable-192.png", opaque=True)
    save_png(icon(512, 0.66, bg=glow_bg(512, 512, 256, 256, 290)), APP_ICONS / "maskable-512.png", opaque=True)
    save_png(icon(180, 0.84), APP_ICONS / "apple-touch-icon-180.png", opaque=True)

    # ---- Telegram Mini App ----
    save_png(mark(420), GAME / "logo.png")
    game_points_marks()

    if args.extra_out:
        out = args.extra_out
        save_png(icon(640, 0.86, bg=glow_bg(640, 640, 320, 320, 380)), out / "telegram-profile-640.png", opaque=True)
        save_png(icon(512, 0.86, bg=glow_bg(512, 512, 256, 256, 300)), out / "telegram-bot-avatar-512.png", opaque=True)
        save_png(mark(1024), out / "zyron-mark-1024-transparent.png")
        save_png(icon(1024, 0.86), out / "zyron-mark-1024-black.png", opaque=True)
        wm = wordmark(160)
        horiz = Image.new("RGBA", (200 + 40 + wm.width, 200), (0, 0, 0, 0))
        horiz.alpha_composite(mark(200), (0, 0))
        horiz.alpha_composite(wm, (240, 20))
        save_png(horiz, out / "zyron-logo-horizontal-transparent.png")
        og.save(out / "og-image-1200x630.jpg", "JPEG", quality=90)
        shutil.copyfile(SVG_MARK, out / "zyron-mark.svg")


if __name__ == "__main__":
    main()

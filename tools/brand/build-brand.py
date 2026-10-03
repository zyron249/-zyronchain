#!/usr/bin/env python3
"""ZYRON CHAIN brand asset pipeline (wolf + Z mark).

Reproducibly derives every website / PWA / Telegram Mini App brand asset from the two master
artworks in tools/brand/source/ using Pillow only (no network, no paid services):

    python3 tools/brand/build-brand.py [--extra-out DIR]

--extra-out additionally writes the Telegram profile photo (640x640), bot avatar (512x512) and a
brand kit (transparent marks, horizontal logo) to DIR for manual upload. Re-run
`node tools/pwa-wallet/stamp-app.mjs` afterwards so the PWA service worker / SRI pins stay current.
"""
from __future__ import annotations

import argparse
import base64
import io
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SRC = Path(__file__).resolve().parent / "source"
WEB = ROOT / "website"
BRAND = WEB / "brand"
APP_ICONS = WEB / "app" / "icons"
GAME = ROOT / "telegram-game" / "frontend"

# Palette sampled from the master artwork (see tools/brand/README.md).
VOID = (2, 5, 10)          # #02050a page background
NAVY = (7, 26, 51)         # #071a33 icon glow centre
BLUE = (10, 159, 245)      # #0a9ff5 electric blue (median vivid blue in the logo)

# Mark crop in the 1254x1254 square master: wolf + Z + ring, text-free (text starts at y=911).
MARK_BOX = (205, 93, 1015, 903)
# Slightly tighter crop centred on the wolf for tiny favicons.
TIGHT_BOX = (198, 103, 988, 893)
TEXT_FADE_FROM = 885       # rows below this fade to black so no text glow leaks into the mark


def load(name: str) -> Image.Image:
    return Image.open(SRC / name).convert("RGB")


def clean_black(img: Image.Image) -> Image.Image:
    """Lift the near-black background (#010203 noise) to pure black without touching the art."""
    a = np.asarray(img).astype(np.float32) / 255.0
    a = np.clip((a - 0.012) / 0.988, 0, 1)
    return Image.fromarray((a * 255 + 0.5).astype(np.uint8), "RGB")


def crop_mark(square: Image.Image, box) -> Image.Image:
    a = np.asarray(square).astype(np.float32).copy()
    top = box[1]
    for y in range(TEXT_FADE_FROM, box[3]):
        a[y] *= max(0.0, 1 - (y - TEXT_FADE_FROM) / (box[3] - TEXT_FADE_FROM))
    return clean_black(Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGB").crop(box))


def to_rgba(img: Image.Image, fill_core: bool = True) -> Image.Image:
    """Exact 'screen' -> alpha conversion for art on black, with the solid wolf interior kept opaque.

    Glow pixels C = a*F over black are unmixed to (F, a) with a = max(C); dark wolf facets inside the
    silhouette are filled to full opacity so the mark stays solid on any background.
    """
    c = np.asarray(img).astype(np.float32) / 255.0
    screen = np.clip((c.max(axis=2) - 0.02) / 0.98, 0, 1)
    alpha = screen
    if fill_core:
        r, g, b = c[..., 0], c[..., 1], c[..., 2]
        core = (r > 0.45 * b) & (c.max(axis=2) > 35 / 255)
        mask = Image.fromarray((core * 255).astype(np.uint8), "L").copy()
        h, w = core.shape
        for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
            if mask.getpixel(seed) == 0:
                ImageDraw.floodfill(mask, seed, 128)
        filled = np.asarray(mask) != 128
        # Round morphological closing (Gaussian dilate -> erode, ~36 px) seals the dark fur gaps that open
        # onto the background, so the silhouette also stays solid on light backgrounds.
        def blur(m, r):
            return np.asarray(Image.fromarray((m * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(r))) / 255.0
        dilated = blur(filled.astype(np.float32), 22) > 0.05
        closed = blur(dilated.astype(np.float32), 22) > 0.95
        filled = filled | closed
        # Fill holes again now that the gaps are sealed (blue-lit inner ear, the Z counters).
        mask = Image.fromarray((filled * 255).astype(np.uint8), "L").copy()
        for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
            if mask.getpixel(seed) == 0:
                ImageDraw.floodfill(mask, seed, 128)
        filled = np.asarray(mask) != 128
        soft = np.asarray(Image.fromarray((filled * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(1.2))) / 255.0
        # Erode the soft edge slightly so no dark halo appears around the silhouette.
        soft = np.clip((soft - 0.35) / 0.65, 0, 1)
        alpha = np.maximum(screen, soft)
    safe = np.maximum(alpha, 1e-6)[..., None]
    fg = np.clip(c / safe, 0, 1)
    out = np.dstack([fg, alpha]) * 255 + 0.5
    return Image.fromarray(out.astype(np.uint8), "RGBA")


def resize_rgba(img: Image.Image, size) -> Image.Image:
    # Premultiplied resampling: no dark/bright fringes at transparent edges.
    return img.convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")


def radial_bg(size: int, inner=NAVY, outer=VOID, reach=0.75) -> Image.Image:
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    d = np.sqrt((x - size / 2 + 0.5) ** 2 + (y - size / 2 + 0.5) ** 2) / (size * reach)
    t = np.clip(d, 0, 1)[..., None] ** 1.4
    col = np.array(inner, np.float32) * (1 - t) + np.array(outer, np.float32) * t
    return Image.fromarray(col.astype(np.uint8), "RGB")


def icon(mark_rgba: Image.Image, size: int, scale: float, rounded: float = 0.0, bg: Image.Image | None = None,
         sharpen: bool = False) -> Image.Image:
    canvas = (bg or radial_bg(size)).convert("RGBA")
    m = int(round(size * scale))
    mark = resize_rgba(mark_rgba, (m, m))
    if sharpen:
        mark = mark.filter(ImageFilter.UnsharpMask(radius=0.6, percent=60, threshold=1))
    canvas.alpha_composite(mark, ((size - m) // 2, (size - m) // 2))
    if rounded:
        mask = Image.new("L", (size * 4, size * 4), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=int(size * 4 * rounded), fill=255)
        canvas.putalpha(mask.resize((size, size), Image.LANCZOS))
    return canvas


def save_png(img: Image.Image, path: Path, opaque: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    (img.convert("RGB") if opaque else img).save(path, "PNG", optimize=True)


def save_web(img: Image.Image, stem: Path, jpg: bool = True, q: int = 80) -> None:
    stem.parent.mkdir(parents=True, exist_ok=True)
    rgb = img.convert("RGB")
    rgb.save(stem.with_suffix(".webp"), "WEBP", quality=q, method=6)
    if jpg:
        rgb.save(stem.with_suffix(".jpg"), "JPEG", quality=q + 2, optimize=True, progressive=True, subsampling=0)


def png_data_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def wordmark(square: Image.Image) -> Image.Image:
    """'ZYRON CHAIN' chrome lettering from the master, as a tight transparent strip."""
    a = np.asarray(square).astype(np.float32)
    band = a[905:1015]
    lum = band.max(axis=2)
    ys, xs = np.where(lum > 40)
    box = (int(xs.min()) - 6, 905 + int(ys.min()) - 6, int(xs.max()) + 7, 905 + int(ys.max()) + 7)
    return to_rgba(clean_black(square.crop(box)), fill_core=False)


def banner_variants(banner: Image.Image) -> None:
    w, h = banner.size
    for width in (2172, 1600, 1080):
        img = banner if width == w else banner.resize((width, round(h * width / w)), Image.LANCZOS)
        save_web(img, BRAND / f"zyron-banner-{width}", jpg=width != 2172, q=78)
    # Mobile art direction: tighter crop that keeps the wordmark and the wolf.
    crop = banner.crop((190, 0, 1890, h))
    for width in (1080, 720):
        img = crop.resize((width, round(crop.height * width / crop.width)), Image.LANCZOS)
        save_web(img, BRAND / f"zyron-banner-m-{width}", jpg=width == 720, q=78)


def og_image(banner: Image.Image) -> Image.Image:
    W, H = 1200, 630
    # Background: the banner itself, cover-scaled, blurred and darkened.
    scale = max(W / banner.width, H / banner.height)
    bg = banner.resize((round(banner.width * scale), round(banner.height * scale)), Image.LANCZOS)
    left, top = (bg.width - W) // 2, (bg.height - H) // 2
    bg = bg.crop((left, top, left + W, top + H)).filter(ImageFilter.GaussianBlur(18))
    bg = Image.blend(bg, Image.new("RGB", (W, H), VOID), 0.55)
    # Sharp banner band (wordmark + wolf), feathered top and bottom into the background.
    crop = banner.crop((150, 0, 1950, banner.height))
    bw = W
    bh = round(crop.height * bw / crop.width)
    sharp = crop.resize((bw, bh), Image.LANCZOS)
    y0 = (H - bh) // 2
    feather = np.ones((bh, bw), np.float32)
    f = 70
    ramp = np.linspace(0, 1, f, dtype=np.float32)
    feather[:f] *= ramp[:, None]
    feather[-f:] *= ramp[::-1][:, None]
    mask = Image.fromarray((feather * 255).astype(np.uint8), "L")
    out = bg.copy()
    out.paste(sharp, (0, y0), mask)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--extra-out", type=Path, default=None)
    args = ap.parse_args()

    square = load("zyron-chain-logo-square.png")
    banner = load("zyron-chain-banner.png")

    mark_black = crop_mark(square, MARK_BOX)            # 810x810, ring included, black background
    mark = to_rgba(mark_black)                         # transparent
    tight = to_rgba(crop_mark(square, TIGHT_BOX))
    text = wordmark(square)

    # ---- website root (names are part of the website CI contract) ----
    save_png(resize_rgba(mark, (192, 192)), WEB / "brand-mark.png")
    save_png(icon(tight, 32, 1.0, rounded=0.22, bg=Image.new("RGB", (32, 32), VOID), sharpen=True), WEB / "favicon-32.png")
    save_png(icon(tight, 16, 1.0, rounded=0.2, bg=Image.new("RGB", (16, 16), VOID), sharpen=True), BRAND / "favicon-16.png")
    save_png(icon(tight, 48, 1.0, rounded=0.22, bg=Image.new("RGB", (48, 48), VOID), sharpen=True), BRAND / "favicon-48.png")
    ico_frames = [icon(tight, s, 1.0, rounded=0.22, bg=Image.new("RGB", (s, s), VOID), sharpen=True) for s in (16, 32, 48)]
    ico_frames[2].save(WEB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=ico_frames[:2])
    save_png(icon(mark, 180, 0.9), WEB / "apple-touch-icon.png", opaque=True)
    save_png(icon(mark, 192, 0.9), WEB / "icon-192.png", opaque=True)
    save_png(icon(mark, 512, 0.9), BRAND / "icon-512.png", opaque=True)

    # SVG favicon / logo: system-font vector type + the raster mark (no remote fonts, CSP-safe).
    fav_uri = png_data_uri(icon(tight, 64, 1.0, rounded=0.22, bg=Image.new("RGB", (64, 64), VOID), sharpen=True))
    (WEB / "favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 96 96" width="96" height="96" role="img" aria-labelledby="t">'
        '<title id="t">ZyronChain</title>'
        f'<image width="96" height="96" href="{fav_uri}" xlink:href="{fav_uri}"/></svg>\n', encoding="utf-8")
    logo_uri = png_data_uri(resize_rgba(mark, (128, 128)))
    (WEB / "logo.svg").write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 640 160" width="640" height="160" role="img" aria-labelledby="t d">
<title id="t">ZyronChain</title><desc id="d">ZYRON CHAIN wolf and Z mark. VERIFIABLE LAYER-1</desc>
<defs>
<linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".46" stop-color="#d8dce0"/><stop offset=".56" stop-color="#8d949a"/><stop offset="1" stop-color="#f4f7f9"/></linearGradient>
<linearGradient id="blue" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4fd8fb"/><stop offset="1" stop-color="#0a9ff5"/></linearGradient>
</defs>
<image x="0" y="0" width="160" height="160" href="{logo_uri}" xlink:href="{logo_uri}"/>
<text x="178" y="92" fill="url(#chrome)" font-family="'Segoe UI',Arial,Helvetica,sans-serif" font-size="64" font-weight="700" letter-spacing="6">ZYRON</text>
<text x="452" y="92" fill="#d8dce0" font-family="'Segoe UI',Arial,Helvetica,sans-serif" font-size="40" font-weight="400" letter-spacing="6">CHAIN</text>
<rect x="180" y="110" width="440" height="2" fill="url(#blue)" opacity=".85"/>
<text x="180" y="138" fill="#4fd8fb" font-family="ui-monospace,Consolas,monospace" font-size="16" letter-spacing="5">VERIFIABLE LAYER-1</text>
</svg>
''', encoding="utf-8")

    # ---- header wordmark + banner + og ----
    th = 80
    save_png(resize_rgba(text, (round(text.width * th / text.height), th)), BRAND / "zyron-wordmark.png")
    banner_variants(banner)
    og = og_image(banner)
    og.save(BRAND / "og-image.jpg", "JPEG", quality=84, optimize=True, progressive=True)

    # ---- PWA wallet (website/app) ----
    save_png(icon(mark, 192, 0.9), APP_ICONS / "icon-192.png", opaque=True)
    save_png(icon(mark, 512, 0.9), APP_ICONS / "icon-512.png", opaque=True)
    save_png(icon(mark, 192, 0.72, bg=radial_bg(192, reach=0.62)), APP_ICONS / "maskable-192.png", opaque=True)
    save_png(icon(mark, 512, 0.72, bg=radial_bg(512, reach=0.62)), APP_ICONS / "maskable-512.png", opaque=True)
    save_png(icon(mark, 180, 0.9), APP_ICONS / "apple-touch-icon-180.png", opaque=True)

    # ---- Telegram Mini App (ZYRON NODE) ----
    save_png(resize_rgba(mark, (420, 420)), GAME / "logo.png")

    if args.extra_out:
        out = args.extra_out
        out.mkdir(parents=True, exist_ok=True)
        save_png(icon(mark, 640, 0.92), out / "telegram-profile-640.png", opaque=True)
        save_png(clean_black(square).resize((640, 640), Image.LANCZOS), out / "telegram-profile-640-with-text.png", opaque=True)
        save_png(icon(mark, 512, 0.92), out / "telegram-bot-avatar-512.png", opaque=True)
        save_png(mark, out / "zyron-wolf-mark-810-transparent.png")
        save_png(resize_rgba(mark, (1024, 1024)), out / "zyron-wolf-mark-1024-transparent.png")
        save_png(mark_black, out / "zyron-wolf-mark-810-black.png", opaque=True)
        save_png(clean_black(square), out / "zyron-chain-logo-1254-black.png", opaque=True)
        # Horizontal logo: mark + wordmark on transparent.
        H = 256
        m = resize_rgba(mark, (H, H))
        tw = round(text.width * (H * 0.24) / text.height)
        t = resize_rgba(text, (tw, round(H * 0.24)))
        horiz = Image.new("RGBA", (H + 24 + tw + 16, H), (0, 0, 0, 0))
        horiz.alpha_composite(m, (0, 0))
        horiz.alpha_composite(t, (H + 24, (H - t.height) // 2))
        save_png(horiz, out / "zyron-logo-horizontal-transparent.png")
        bg = Image.new("RGBA", horiz.size, VOID + (255,))
        bg.alpha_composite(horiz)
        save_png(bg, out / "zyron-logo-horizontal-black.png", opaque=True)
        og.save(out / "og-image-1200x630.jpg", "JPEG", quality=88)
    print("brand assets written")


if __name__ == "__main__":
    main()

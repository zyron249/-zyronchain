# ZYRON CHAIN brand assets

Official mark: a white **Z** with two short bars above and below, on a solid gold coin. The vector master is
[`source/zyron-mark.svg`](source/zyron-mark.svg); every derived asset is drawn locally with Pillow from the same
geometry, no network or paid services:

```bash
python3 tools/brand/build-brand.py --extra-out /tmp/zyron-brand   # writes website/, website/app/icons, telegram-game/frontend/logo.png
node tools/pwa-wallet/stamp-app.mjs                                # refresh PWA SRI + service-worker pins
```

`--extra-out` also writes the manual-upload kit: `telegram-profile-640.png`, `telegram-bot-avatar-512.png`,
transparent / black marks (1024 px), horizontal logo, the SVG master and the 1200×630 OG image.

## Palette

| Role | Hex | Notes |
| --- | --- | --- |
| Brand gold (primary) | `#f9b700` | the coin |
| Gold hot / glow | `#ffc21a` / `#ffcc33` | links, focus rings, accents on dark |
| Gold light | `#ffe08a` | button highlight |
| Gold deep | `#a87a00` | borders, pressed states |
| White | `#ffffff` | the Z, headings |
| Void / page background | `#0a0a0b` | near-black |
| Surface | `#141416` / `#1b1b1e` | charcoal panels |
| Body text / muted | `#d6d1c6` / `#aaa497` | warm greys, WCAG AA on the void |
| Warning | `#ff9e57` | orange, distinct from brand gold |

Buttons use dark text (`#0a0a0b`) on the `#ffe08a → #ffc21a → #f9b700` gradient (> 10:1). Gold `#f9b700` on
`#0a0a0b` is about 11:1.

## Derived files

| File | Use |
| --- | --- |
| `website/brand-mark.png` (192, transparent) | header / footer / wallet identity (gold coin) |
| `website/brand/zyron-wordmark.png` | header wordmark (white "ZYRON" + gold "CHAIN") |
| `website/brand/zyron-banner-{1080,1600,2172}.webp`, `-{1080,1600}.jpg` | homepage hero |
| `website/brand/zyron-banner-m-{720,1080}.webp`, `-720.jpg` | homepage hero, phones (tighter crop) |
| `website/brand/og-image.jpg` (1200×630) | Open Graph / Twitter card |
| `website/favicon.ico` (16/32/48), `favicon-32.png`, `brand/favicon-{16,48}.png`, `favicon.svg` | browser tabs |
| `website/apple-touch-icon.png` (180), `icon-192.png`, `brand/icon-512.png` | home screen / JSON-LD logo |
| `website/app/icons/*` (192/512 any + maskable, 180 apple) | PWA wallet |
| `telegram-game/frontend/logo.png` (420, transparent) | ZYRON NODE Mini App |
| `telegram-game/frontend/points-mark-{52,104,156}.png` (transparent, tight crop) | Zyron Points mark in ZYRON NODE, 1x/2x/3x (`--points-only` rebuilds just these) |

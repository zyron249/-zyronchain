# ZYRON CHAIN brand assets

Official mark: chrome wolf head forming a **Z**, electric-blue glow, black background ("ZYRON CHAIN").
Master artwork lives in [`source/`](source/) (square logo 1254×1254, wide banner 2172×724). Every
derived asset is produced locally with Pillow, no network or paid services:

```bash
python3 tools/brand/build-brand.py --extra-out /tmp/zyron-brand   # writes website/, website/app/icons, telegram-game/frontend/logo.png
node tools/pwa-wallet/stamp-app.mjs                                # refresh PWA SRI + service-worker pins
```

`--extra-out` also writes the manual-upload kit: `telegram-profile-640.png` (Telegram channel/group photo),
`telegram-bot-avatar-512.png` (BotFather `/setuserpic`), `telegram-profile-640-with-text.png`,
transparent/black marks (810, 1024 px), horizontal logo and the 1200×630 OG image.

## Palette (sampled from the master artwork)

| Role | Hex | Source |
| --- | --- | --- |
| Void / page background | `#02050a` | logo background `#010203`, banner `#01050a` |
| Surface | `#070d18` / `#0b1526` | derived |
| Electric blue (primary accent) | `#0a9ff5` | median vivid blue in the logo |
| Glow (links, focus, accents on dark) | `#4fd8fb` | hot cyan glow `#4fd8fb` |
| Hot highlight | `#1ccbfb` | brightest blue band |
| Mid blue | `#3796db` | |
| Deep blue | `#2c68ad` | |
| Navy | `#04336e` | darkest glow band |
| Chrome 1–4 | `#f4f7f9` `#d8dce0` `#b1b8c0` `#8d949a` | silver bands of the wolf |
| Dark facet | `#24282d` | |
| Warning (kept amber on purpose) | `#ffc466` | not brand: means "gated / careful" |

Buttons use dark text (`#02050a`) on the `#8be9ff → #1ccbfb → #0a9ff5` gradient (≥ 7:1). Body text on the
void background is `#c3ccd6`, muted `#9aa6b4` (≥ 7:1), both WCAG AA.

## Derived files

| File | Use |
| --- | --- |
| `website/brand-mark.png` (192, transparent) | header / footer / wallet identity |
| `website/brand/zyron-wordmark.png` | header wordmark (chrome "ZYRON CHAIN" from the master) |
| `website/brand/zyron-banner-{1080,1600,2172}.webp`, `-{1080,1600}.jpg` | homepage hero |
| `website/brand/zyron-banner-m-{720,1080}.webp`, `-720.jpg` | homepage hero, phones (tighter crop) |
| `website/brand/og-image.jpg` (1200×630) | Open Graph / Twitter card |
| `website/favicon.ico` (16/32/48), `favicon-32.png`, `brand/favicon-{16,48}.png`, `favicon.svg` | browser tabs |
| `website/apple-touch-icon.png` (180), `icon-192.png`, `brand/icon-512.png` | home screen / JSON-LD logo |
| `website/app/icons/*` (192/512 any + maskable, 180 apple) | PWA wallet |
| `telegram-game/frontend/logo.png` (420, transparent) | ZYRON NODE Mini App |

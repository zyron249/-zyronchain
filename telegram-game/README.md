# ZYRON NODE

Telegram Mini App for the ZyronChain community. Operators run a **fictional node**, spend **Zyron Points**, and climb off-chain leaderboards.

One tap starts the node. It keeps cycling until energy runs out, with a live regen countdown. Streak, quest, and level rewards are collected from supply chests. Amounts stay server-side.

This directory is a separate service. It does not import or modify `l1/` consensus, validator signing, mining, or the legacy Python chain.

Zyron Points are not ZYN and not Zyrum. There is no conversion rate. The service does not mint tokens, store seeds, or send mainnet transfers. Season snapshots and the activity-ledger cutoff are exports only.

Competitive tiers (Bronze, Silver, Gold, Diamond) follow lifetime Zyron Points and do not reset daily. An append-only activity ledger records earnings, tier changes, and all-time rank changes so a later distribution can be audited. The export path is in `docs/TIERS.md`.

## What you need locally

1. Python 3.12 and PostgreSQL 16.
2. A Telegram bot token from BotFather, only when you want the real Mini App or the bot process.
3. Optional: a Zyron RPC URL from your own loopback devnet (`cd l1 && npm run devnet`). This repository does not publish a public RPC. Leave `ZYRON_RPC_URL` empty until you have one. Do not assume port 9137 is running.

```sh
cd telegram-game
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
createdb zyron_node   # or use the compose file below
export DATABASE_URL=postgresql://zyron:zyron@127.0.0.1:5432/zyron_node
export TELEGRAM_BOT_TOKEN=        # required for real Telegram initData
export TELEGRAM_BOT_USERNAME=
export WEBAPP_URL=https://your-host.example/   # HTTPS before the menu button will open
export ADMIN_TOKEN=replace-with-a-long-random-string
export DEV_AUTH_BYPASS=1          # local browser only; never in production
```

Copy `.env.example` for the full checklist. The process does not auto-load a `.env` file; export the variables or use Compose `env_file`.

## Run

```sh
python -m zyron_node
```

The API listens on `0.0.0.0:$PORT` (default 8000).

- Mini App (same-origin shell): `http://127.0.0.1:8000/`
- Static shell against a local API: `python scripts/build_static.py --out /tmp/site --api http://127.0.0.1:8000`, serve `/tmp/site`, and start the API with `CORS_ORIGINS=http://127.0.0.1:<static port>`
- Admin: `http://127.0.0.1:8000/admin`
- Health: `/healthz` and `/readyz`

Bot process, after the token and database are set:

```sh
python -m zyron_node.bot
```

That registers `/start`, `/play`, `/profile`, `/rank`, `/invite`, `/help`, and a **Play Zyron** menu button when `WEBAPP_URL` is HTTPS. It does not change Telegram group settings, history, admins, or other bots.

Docker:

```sh
cp .env.example .env
# fill tokens in .env
docker compose up --build
```

Compose runs the API and the bot as separate containers. The `api` service overrides the image command so it does not start a second poller beside the `bot` service.

The image default command is `scripts/start-web-and-bot.sh`. It starts `python -m zyron_node.bot` in the background and execs `python -m zyron_node` in the foreground, with the image `PYTHONPATH` and the rest of the container environment. On a single Render Free web service, leave Docker Command empty so that entrypoint runs both processes. Free web services still spin down after inactivity, so the bot polls only while the service is awake. A dedicated worker running `python -m zyron_node.bot`, with the web service on `python -m zyron_node`, is still the better split when a worker is available.

## Hosting: instant open

Render Free web services sleep after 15 minutes without inbound traffic and need 30–60 s to start. Play Zyron
therefore opens from an always-on static host, and only the API runs on the `zyron-node` web service:

| Piece | Where | Notes |
|---|---|---|
| Play Zyron shell (HTML, JS, CSS, images) | GitHub Pages, `https://zyron249.github.io/-zyronchain/` | Built by `scripts/build_static.py`, deployed by `.github/workflows/telegram-game-pages.yml` on merge to `main`. Never sleeps. |
| Game API + bot | Render web service `zyron-node` (`https://zyron-node.onrender.com`) | Unchanged Docker service. Still serves `/` for older links. |
| Keep-warm | `.github/workflows/telegram-game-keep-warm.yml` | Pings `/healthz` (no database) every 10 minutes. Best effort. |

How a cold open looks: the branded splash paints from the static host at once; `frontend/wake.js` pings
`/healthz` and, after 1.2 s without an answer, shows **Waking server…** with a progress bar, elapsed time and
automatic retries. Start node and every other action stay disabled until the API answers. Nothing is ever
sent to game endpoints before that.

Security of the split:

- The API sends CORS headers only to origins in `cors_origins`: the origin of `MINIAPP_URL` plus optional
  `CORS_ORIGINS` (comma-separated, https in production, no wildcard). Admin routes never answer cross-origin.
  No cookies or credentials mode; auth stays in the `Authorization: tma <initData>` header and the HMAC check
  with the bot token stays server-side.
- The static page carries a meta CSP: `default-src 'none'`, scripts from itself and `telegram.org`, and
  `connect-src` limited to the API origin. It holds no secrets.
- The bot points the menu button and every Play Zyron button at `MINIAPP_URL`. On any hosted deployment
  (`ENVIRONMENT=production`, or any Render service, which always sets `RENDER=true`) it defaults to the GitHub
  Pages URL, so no Render environment change is needed. Set `MINIAPP_URL` only to move the shell.

Telegram (BotFather) notes: menu and inline Play buttons are set by the bot itself on start. If a Main Mini App
or a direct-link Mini App was configured in BotFather, update its URL there to
`https://zyron249.github.io/-zyronchain/` (BotFather → `/mybots` → @ZyronNodeBot → Bot Settings → Configure Mini
App / Menu Button). `/setdomain` is only for the Login Widget and is not needed.

Budget: one always-on Free web service uses about 744 of the 750 free instance hours per Render workspace per
month, so other Free web services in the same workspace would push the total over the limit. GitHub Actions
minutes are free for public repositories; scheduled runs can be delayed by several minutes.

## Tests

```sh
export DATABASE_URL=postgresql://zyron:zyron@127.0.0.1:5432/zyron_node
export ENVIRONMENT=test ALLOW_TEST_CLOCK=1
pytest -q
```

The root ZyronChain pytest suite ignores this directory. Game CI is `.github/workflows/telegram-game-ci.yml`.

## Layout

| Path | Role |
|---|---|
| `src/zyron_node/` | API, bot, economy, RPC client |
| `frontend/` | Mobile Mini App and admin page |
| `frontend/blocks.js` | Block chain on the home orbit ring: glowing isometric blocks, inline SVG, transform-only CSS motion, moves only while the node is RUNNING, snaps a block per completed cycle, parked under reduced motion |
| `frontend/builders.js` | Builders beside the orbit ring: flat-vector characters with helmet lights and pickaxes that swing while the node is RUNNING; each completed cycle sends a carved block to the head of the chain |
| `migrations/` | PostgreSQL schema, including Season 0 |
| `docs/L1_FINDINGS.md` | Phase 0 chain notes |
| `docs/THREAT_MODEL.md` | Abuse cases and controls |
| `docs/ECONOMY.md` | Point and energy formulas |
| `docs/TIERS.md` | Competitive tiers and the activity-ledger export |
| `docs/ADMIN.md` | Dashboard actions |

## Safety rails already in the code

- Points, energy, level, quests, and referral payouts are server-authoritative.
- Telegram `initData` is verified with the bot token.
- Rewards are idempotent inside database transactions.
- Wallet link stores a public `ZYN` address only.
- The RPC client is GET-only, cached, and rate-limited.
- `DEV_AUTH_BYPASS` and `ALLOW_TEST_CLOCK` will not boot in production.
- `X-Forwarded-For` and similar headers are used only when the TCP peer is listed in `TRUSTED_PROXIES` or `TRUST_PROXY`.

Do not deploy this to mainnet, wire a treasury, or announce a public launch from this MVP. Those need a separate approval.

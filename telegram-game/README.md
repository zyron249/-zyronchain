# ZYRON NODE

Telegram Mini App for the ZyronChain community. Operators run a **fictional node**, spend **Zyron Points**, and climb off-chain leaderboards.

This directory is a separate service. It does not import or modify `l1/` consensus, validator signing, mining, or the legacy Python chain.

Zyron Points are not ZYN and not Zyrum. There is no conversion rate. The service does not mint tokens, store seeds, or send mainnet transfers. Season snapshots are exports only.

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

- Mini App: `http://127.0.0.1:8000/`
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
| `migrations/` | PostgreSQL schema, including Season 0 |
| `docs/L1_FINDINGS.md` | Phase 0 chain notes |
| `docs/THREAT_MODEL.md` | Abuse cases and controls |
| `docs/ECONOMY.md` | Point and energy formulas |
| `docs/ADMIN.md` | Dashboard actions |

## Safety rails already in the code

- Points, energy, level, quests, and referral payouts are server-authoritative.
- Telegram `initData` is verified with the bot token.
- Rewards are idempotent inside database transactions.
- Wallet link stores a public `ZYN` address only.
- The RPC client is GET-only, cached, and rate-limited.
- `DEV_AUTH_BYPASS` and `ALLOW_TEST_CLOCK` will not boot in production.

Do not deploy this to mainnet, wire a treasury, or announce a public launch from this MVP. Those need a separate approval.

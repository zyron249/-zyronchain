# ZYRON NODE economy

Zyron Points are an off-chain game balance. They are not ZYN, not Zyrum, and they have no conversion rate. A node cycle is fictional gameplay. It does not submit a mining claim and it does not change chain supply.

All numbers below are computed in `src/zyron_node/economy.py`. The database ledger is the balance of record.

## Cycle

- Costs 1 energy.
- Reward = `(1 + CPU + ValidatorPower // 2) * (10000 + min(streak, 15) * 200 + Reputation * 150) // 10000`.
- Minimum 1, maximum 250.
- A new operator earns 1 point per cycle.
- Server interval default: 800ms between accepted cycles.

## Energy

- Cap = `min(5000, 100 + EnergyCore * 20 + Storage * 2 + Security)`.
- One point returns every `max(60, 300 - EnergyCore * 10)` seconds.
- Time spent already at the cap is not banked.
- Spending sets the regen clock to server time.

## Upgrades

Cost to leave level `n` is `round(base * growth^n)` using half-up rounding. Levels start at 0.

| Module | Base | Growth | Max | Effect |
|---|---:|---:|---:|---|
| CPU | 20 | 1.45 | 20 | +1 base point per cycle per level |
| Network | 30 | 1.48 | 20 | +8 Network Power |
| Storage | 25 | 1.46 | 20 | +1 point on quest payouts, +2 energy cap |
| Validator Power | 60 | 1.55 | 15 | +1 base point per 2 levels, +12 Network Power. Not a chain validator. |
| Security | 28 | 1.47 | 20 | +4 Network Power, +1 energy cap. Does not weaken anti-cheat. |
| Energy Core | 35 | 1.50 | 20 | +20 energy cap, faster regen |
| Reputation | 40 | 1.52 | 15 | +1.5% cycle reward per level |

Node level = `1 + total upgrade levels // 4`.

Network Power = `10 + CPU*2 + Network*8 + Storage*3 + Validator*12 + Security*4 + Energy + Reputation*5`.

## Streak

One claim per UTC date, using server time. A missed day resets the next claim to day 1. Days 1–30 have explicit rewards in `STREAK_REWARDS`. Later days keep paying the day-30 amount. The calendar is visible in the profile so a 30-day track can ship without a second season.

## Referrals

- Referrer: 100 points. Referee: 25 points.
- Paid once, after 15 cycles and 30 minutes by default.
- 20 rewarded referrals per referrer per 7 days.
- No self-link and no mutual link.

## Quests and achievements

Defined in `src/zyron_node/catalog.py`. Completion is derived from the ledger, upgrade rows, streak date, and server-side RPC markers. Claims are unique per period. Storage level adds its level to the quest payout.

Chain quests complete only when this service successfully reads the configured Zyron RPC. If no RPC is configured, those quests stay open.

## Season 0

Migration `001_init.sql` opens Season 0 as active from 2026-09-01. Positive ledger rows store the active season id. Spending points does not reduce season score. Admins can export a JSON snapshot and can close the season. Neither action transfers ZYN or Zyrum.

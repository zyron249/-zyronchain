# ZYRON NODE economy

Zyron Points are an off-chain game balance. They are not ZYN, not Zyrum, and they have no conversion rate. A node cycle is fictional gameplay. It does not submit a mining claim and it does not change chain supply.

All numbers below are computed in `src/zyron_node/economy.py`. The database ledger is the balance of record.

## Cycle

- Costs 1 energy.
- Reward = `(1 + CPU + ValidatorPower // 2 + Efficiency) * (10000 + min(streak, 15) * 200 + Reputation * 150) // 10000`.
- Minimum 1, maximum 250.
- A new operator earns 1 point per cycle.
- Server interval default: 800ms between accepted cycles.

## Energy

- Cap = `min(5000, 100 + EnergyCore * 20 + Storage * 2 + Security + Capacity * 10)`.
- One point returns every `max(60, 300 - EnergyCore * 10 - Recovery * 6)` seconds.
- Cycle and chest-bonus points share a per-UTC-day limit of 59,808 (see Daily play limit).
- Time spent already at the cap is not banked.
- Spending sets the regen clock to server time.
- The profile reports `regenSeconds`, `nextInSeconds`, and `nextAt` (absolute server time of the next point, or null at the cap). The client counts down from those fields.

## Upgrade tree (Upgrades tab)

Three branches sit next to the node modules. Levels are stored in `player_upgrades` under their own ids (`capacity`, `recovery`, `efficiency`) and do **not** count toward node level, level chests or Network Power. A purchase burns Zyron Points from the spendable balance (a negative `point_ledger` row with reason `upgrade`). It never mints points and never lowers lifetime points, tiers or season score.

Cost to leave level `n` is `round(base * growth^n)`, half-up, levels start at 0, hard max 10.

| Branch | Base | Growth | Max | Effect per level |
|---|---:|---:|---:|---|
| Energy capacity | 80 | 1.60 | 10 | +10 max energy |
| Recovery speed | 120 | 1.65 | 10 | -6 s per energy point (floor stays 60 s) |
| Builder efficiency | 150 | 1.70 | 10 | +1 base point per cycle (before streak and Reputation multipliers; cycle cap stays 250) |

Full cost tables (level 0→1 … 9→10):

| Branch | Costs | Total |
|---|---|---:|
| Energy capacity | 80, 128, 205, 328, 524, 839, 1,342, 2,147, 3,436, 5,498 | 14,527 |
| Recovery speed | 120, 198, 327, 539, 889, 1,468, 2,422, 3,995, 6,593, 10,878 | 27,429 |
| Builder efficiency | 150, 255, 434, 737, 1,253, 2,130, 3,621, 6,155, 10,464, 17,788 | 42,987 |

With the tree the formulas become:

- Energy cap = `min(5000, 100 + EnergyCore*20 + Storage*2 + Security + Capacity*10)`
- Regen = `max(60, 300 - EnergyCore*10 - Recovery*6)` seconds per point
- Cycle base = `1 + CPU + ValidatorPower//2 + Efficiency`, then the same streak/Reputation multiplier and the same 1..250 clamp

Server checks: unknown branch → 400, max level → 409 `max_level`, not enough points → 409 `insufficient_points`. Regen accrued at the old rate is banked before a level changes. `POST /api/tree/upgrade` takes an `idempotencyKey`; a retry with the same key replays the stored result and never spends twice. Per account: 20 calls a minute and 120 an hour.

### Daily play limit (why the tree cannot raise issuance)

Before the tree there was no explicit per-day number, but issuance was bounded by the formulas. The most one operator could earn from cycles in a UTC day was every node module maxed, a 15+ day streak, a full cell at 00:00 and every regen tick that day:

- cap 560 energy + 86,400 / 100 s = **1,424 cycles**
- reward `(1 + 20 + 7) * (10000 + 15*200 + 15*150) // 10000` = **42 points**
- ceiling = 1,424 × 42 = **59,808 points per operator per UTC day**

That ceiling is now an enforced constant, `DAILY_PLAY_POINTS_CAP = 59,808` (computed from the module table in `economy.py` and pinned by tests). A fully upgraded tree could in theory reach 2,100 cycles × 57 = 119,700, so the limit binds: a cycle that would cross it is paid only the remainder, and further cycles return 409 `daily_cap` until 00:00 UTC. Node cycles **and** the daily chest bonus count against the same limit (`players.play_points_day` / `play_points_today`). Upgrades let an operator reach the limit sooner; they never move it. Streak, quest, level, achievement and referral rewards keep their existing fixed amounts and caps.

Zyron Points stay off-chain and have no conversion rate. Any later activity distribution is separate, comes only from the fixed 5,000,000 ZYN ecosystem/community reserve and is bounded on-chain by that reserve (see `docs/FIXED_SUPPLY_TOKENOMICS.md`). Team accounts can buy upgrades and open chests but stay off every board and export.

## Node modules

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

Cycling, upgrading, streak claims, wallet links, and chain reads do not pay quest points by themselves. The Mini App collects a ready quest by opening its supply chest (`POST /api/chests/open`). `POST /api/quests/sync` still claims every ready quest in one call, for older clients and for operators who want to settle them together.

## Supply chests

Chests do not mint ZYN. Quest and level chests pay fixed amounts. Only the free daily chest has a bonus roll.

| Chest | When it opens | Payout |
|---|---|---|
| Daily supply | Once per UTC day, until the streak is claimed | The existing streak reward for that day, plus one free bonus roll |
| Quest | The quest target is met and that period is unclaimed | The existing quest payout, including Storage |
| Level | Node level is at least this level, once each from level 2 | `10 * (level - 1)` Zyron Points |

### Free daily chest bonus

Free, one roll per operator per UTC day, made when the daily chest (the streak claim, via either `/api/chests/open` or `/api/streak/claim`) pays. The roll uses `secrets.randbelow(1000)` and the result is stored in `daily_chest_rolls (player_id, day)` so it can never be re-rolled. There are no paid chests. The odds are fixed in `DAILY_CHEST_OUTCOMES` and shown in the Upgrades and Chests tabs:

| Outcome | Weight /1000 | Chance |
|---|---:|---:|
| +5 off-chain points | 550 | 55.0% |
| +10 off-chain points | 250 | 25.0% |
| +20 off-chain points | 120 | 12.0% |
| +50 off-chain points | 30 | 3.0% |
| Builder cosmetic | 50 | 5.0% |

Expected bonus ≈ 9.15 points a day; the most is 50. A cosmetic roll gives one cosmetic you do not own yet (Bright head lamps, Blue pickaxes, Wolf operator badge). If you own all three it pays +50 off-chain points instead. Bonus points count against the daily play limit and are clamped to what is left of it.

Opening the daily chest is the streak claim. A second open returns `replayed: true` and `gained: 0`. Quest ledger keys match `/api/quests/sync`, so the two paths cannot both pay. Level claims live in `chest_claims`.

Chain quests complete only when this service successfully reads the configured Zyron RPC. If no RPC is configured, those quests stay open.

## Competitive tiers

Tiers are a function of lifetime Zyron Points only. They do not reset with the daily board, the week, or the season, and spending points on modules does not lower them. Thresholds and the activity ledger used for a future fair distribution are described in `docs/TIERS.md`.

## Season 0

Migration `001_init.sql` opens Season 0 as active from 2026-09-01. Positive ledger rows store the active season id. Spending points does not reduce season score. Admins can export a JSON snapshot and can close the season. Neither action transfers ZYN or Zyrum.

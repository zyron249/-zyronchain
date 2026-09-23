# Competitive tiers and the activity ledger

Zyron Points stay off-chain. Tiers and this ledger do not mint ZYN or Zyrum, and neither export pays anyone.

## How a tier is chosen

The metric is **lifetime Zyron Points** (`players.lifetime_points`). That counter only increases when points are earned. Upgrades spend spendable `points` and leave the lifetime total in place. Daily, weekly, and season boards do not move a tier.

Thresholds live in `src/zyron_node/tiers.py`:

| Tier | Turkish | Lifetime Zyron Points |
|---|---|---:|
| Bronze | Bronz | 250 |
| Silver | Gümüş | 2,500 |
| Gold | Altın | 15,000 |
| Diamond | Elmas | 60,000 |

Below 250 the operator is unranked. A new operator earns 1 point per cycle and starts with 100 energy, so Bronze is past the first full cell plus the day-1 chest, not a single tap. Silver is about ten times that. Gold and Diamond stay high because cycle reward is capped at 250.

`/api/me` and `/api/leaderboard` return `tier`, `nextTier`, `tierProgress`, and `thresholds`. The Mini App displays those fields. It does not keep a second copy of the numbers. The same payloads include the all-time tier on each leaderboard row. Rank copy compares you with the next tier (lifetime points) and with the real operator directly above you on the selected board. Empty boards stay empty.

Crossing a threshold returns `tierUpgrades` on the earn response. The Mini App toasts that tier and fires the Telegram success haptic when the client provides one.

## Activity ledger

`activity_ledger` is insert-only. A trigger rejects `UPDATE` and `DELETE`. Game code has no update or delete for this table.

Columns: `player_id`, `telegram_id`, `event_type`, `amount` (nullable), `metadata` JSON, `created_at`. Indexes: `(player_id, created_at)`, `(event_type, created_at)`, `(telegram_id, created_at)`.

| Event | When | `amount` |
|---|---|---|
| `points_earned` | Every positive grant (cycle, streak, quest, chest, achievement, referral) | Points just earned |
| `backfill_snapshot` | Once, for lifetime points that existed before this table | That lifetime total |
| `daily_claim` | Streak / daily supply claim | Payout (do not add into a distribution total) |
| `quest_completed` | Quest payout | Payout (already inside `points_earned`) |
| `chest_opened` | Daily, quest, or level chest payout | Payout (already inside `points_earned`) |
| `tier_upgraded` | Lifetime total crosses a tier | Null. Tier id is in `metadata` |
| `rank_snapshot` | All-time rank changes, plus one opening snapshot at migration | The rank, not points |

`players.lifetime_points` stays the fast counter for the Mini App. The ledger is the audit source.

### Backfill

Migration `003_activity_ledger.sql` creates the table. On that migration only, `seed_opening_ledger` writes one `backfill_snapshot` per player who already had `lifetime_points > 0` and no `points_earned` row, plus one opening `rank_snapshot`. It does not invent a cycle-by-cycle history. Later earnings append `points_earned` on top of that seed. Running the seed again does not insert a second backfill for the same player.

## Export for a fair cutoff

Admin token, same `Authorization: Bearer` header as the other admin routes.

- `GET /api/admin/ledger/summary` — activity counts by type, lifetime points per operator, and who has held all-time #1.
- `GET /api/admin/ledger/reigns?rank=1` — #1 holders, from the first snapshot until the next different holder. `seconds` is the duration. An open reign has `"until": null`.
- `GET /api/admin/ledger/cutoff?at=2026-09-23T00:00:00Z` — JSON rows: `playerId`, `telegramId`, `lifetimePoints`, `tier`, `rankAtCutoff`.
- `GET /api/admin/ledger/cutoff.csv?at=...` — the same rows as CSV: `player_id,telegram_id,lifetime_points,tier,rank_at_cutoff`.

Omit `at` to use the request time. `automaticPayout` is false and `conversionRate` is null. The season snapshot endpoint still omits Telegram ids. This cutoff includes them because a distribution list has to name the operator. It is admin-only.

Lifetime points at a cutoff are:

```sql
SELECT player_id, SUM(amount)::bigint AS lifetime_points
FROM activity_ledger
WHERE event_type IN ('points_earned', 'backfill_snapshot')
  AND amount IS NOT NULL
  AND created_at <= TIMESTAMPTZ '2026-09-23T00:00:00Z'
GROUP BY player_id;
```

Do not add `point_ledger` on top of `backfill_snapshot`, and do not sum `rank_snapshot.amount` (that column is a rank). Rank at the cutoff is that lifetime total, highest first, player id ascending on ties. The API does this and stops at 20,000 rows with `truncated: true` if there are more. For a full extract, run the query above and rank it in the same order.

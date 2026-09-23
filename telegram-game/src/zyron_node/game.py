"""Server-authoritative ZYRON NODE rules. Points, energy, and rewards are never taken from the client."""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timedelta, timezone

from psycopg.errors import UniqueViolation
from psycopg.types.json import Json

from zyron_node.catalog import ACHIEVEMENTS, ACHIEVEMENTS_BY_ID, QUESTS, QUESTS_BY_ID, period_key, utc_day_bounds
from zyron_node.economy import (
    ABUSE_REFERRAL_BLOCK,
    MODULE_ORDER,
    MODULES,
    POINTS_NOTICE,
    REFEREE_REWARD,
    REFERRAL_WEEKLY_CAP,
    REFERRER_REWARD,
    STREAK_REWARDS,
    advance_streak,
    apply_energy,
    cycle_reward,
    empty_levels,
    level_chest_reward,
    max_energy,
    network_power,
    node_level,
    quest_payout,
    regen_interval_seconds,
    seconds_until_next_energy,
    streak_reward,
    upgrade_cost,
)
from zyron_node.rpc import valid_watch_address

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
KEY_RE_SOURCE = r"^[A-Za-z0-9_.:-]{8,80}$"
CHEST_ID_RE = re.compile(r"^(daily|quest:[a-z0-9_]+|level:[1-9][0-9]?)$")


class GameError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code = code
        self.message = message
        self.status = status
        super().__init__(message)


def open_session(pool, identity, ip_hash: str | None, now: datetime, bot_username: str) -> dict:
    with pool.connection() as conn:
        with conn.transaction():
            player = ensure_player(conn, identity, ip_hash, now)
            levels = load_levels(conn, player["id"])
            player = persist_energy(conn, player, levels, now)
            level = node_level(levels)
            if level != player["node_level"]:
                conn.execute("UPDATE players SET node_level = %s WHERE id = %s", (level, player["id"]))
                player = reload_player(conn, player["id"])
            return build_profile(conn, player, levels, now, bot_username)


def run_cycle(pool, player_id: int, key: str, now: datetime, *, min_interval_ms: int, min_cycles: int, min_age: int) -> dict:
    require_key(key)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "cycle", key)
            if replay:
                return replay
            reject_if_banned(player)
            levels = load_levels(conn, player["id"])
            player = persist_energy(conn, player, levels, now)
            if player["last_cycle_at"] is not None:
                elapsed_ms = (now - player["last_cycle_at"]).total_seconds() * 1000
                if elapsed_ms < min_interval_ms:
                    raise GameError("cycle_too_fast", "The node bus is still settling. Try again in a moment.", 429)
            if int(player["energy"]) < 1:
                raise GameError("no_energy", "Energy is empty. It regenerates on server time.", 409)
            reward = cycle_reward(levels, int(player["streak_count"]))
            season = active_season(conn)
            season_id = season["id"] if season else None
            apply_points(conn, player_id, reward, "cycle", f"cycle:{player_id}:{key}", season_id, now)
            updated = conn.execute(
                """
                UPDATE players
                SET energy = energy - 1,
                    cycle_count = cycle_count + 1,
                    last_cycle_at = %s,
                    energy_updated_at = %s
                WHERE id = %s AND energy >= 1
                RETURNING id
                """,
                (now, now, player_id),
            ).fetchone()
            if updated is None:
                raise GameError("no_energy", "Energy is empty. It regenerates on server time.", 409)
            player = reload_player(conn, player_id)
            quests, achievements = sync_rewards(conn, player, levels, now, season_id, include_quests=False)
            qualified = qualify_referral(conn, player_id, now, min_cycles, min_age, season_id)
            player = reload_player(conn, player_id)
            response = {
                "replayed": False,
                "gained": reward,
                "points": int(player["points"]),
                "lifetimePoints": int(player["lifetime_points"]),
                "cycleCount": int(player["cycle_count"]),
                "energy": energy_view(player, levels, now),
                "questsCompleted": quests,
                "achievementsUnlocked": achievements,
                "referralQualified": qualified,
                "serverTime": iso(now),
            }
            store_idempotency(conn, player_id, "cycle", key, response, now)
            return response


def purchase_upgrade(pool, player_id: int, module: str, key: str, now: datetime) -> dict:
    require_key(key)
    if module not in MODULES:
        raise GameError("bad_module", "Unknown node module.", 400)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "upgrade", key)
            if replay:
                return replay
            reject_if_banned(player)
            levels = load_levels(conn, player_id)
            spec = MODULES[module]
            if levels[module] >= spec.max_level:
                raise GameError("max_level", f"{spec.title} is already at maximum level.", 409)
            cost = upgrade_cost(module, levels[module])
            season = active_season(conn)
            season_id = season["id"] if season else None
            apply_points(conn, player_id, -cost, "upgrade", f"upgrade:{player_id}:{key}", season_id, now)
            levels[module] += 1
            conn.execute(
                "UPDATE player_upgrades SET level = %s WHERE player_id = %s AND module = %s",
                (levels[module], player_id, module),
            )
            conn.execute(
                "UPDATE players SET node_level = %s WHERE id = %s",
                (node_level(levels), player_id),
            )
            player = reload_player(conn, player_id)
            quests, achievements = sync_rewards(conn, player, levels, now, season_id, include_quests=False)
            player = reload_player(conn, player_id)
            response = {
                "replayed": False,
                "module": module,
                "level": levels[module],
                "spent": cost,
                "points": int(player["points"]),
                "nodeLevel": int(player["node_level"]),
                "networkPower": network_power(levels),
                "questsCompleted": quests,
                "achievementsUnlocked": achievements,
                "serverTime": iso(now),
            }
            store_idempotency(conn, player_id, "upgrade", key, response, now)
            return response


def claim_streak(pool, player_id: int, now: datetime) -> dict:
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            key = now.date().isoformat()
            replay = replay_of(conn, player_id, "streak", key)
            if replay:
                return replay
            reject_if_banned(player)
            levels = load_levels(conn, player_id)
            new_count, grant = advance_streak(player["streak_last_date"], int(player["streak_count"]), now.date())
            gained = 0
            season = active_season(conn)
            season_id = season["id"] if season else None
            if grant:
                gained = streak_reward(new_count)
                apply_points(conn, player_id, gained, "streak", f"streak:{player_id}:{key}", season_id, now)
                longest = max(int(player["longest_streak"]), new_count)
                conn.execute(
                    """
                    UPDATE players
                    SET streak_count = %s, streak_last_date = %s, longest_streak = %s
                    WHERE id = %s
                    """,
                    (new_count, now.date(), longest, player_id),
                )
            player = reload_player(conn, player_id)
            quests, achievements = sync_rewards(conn, player, levels, now, season_id, include_quests=False)
            player = reload_player(conn, player_id)
            response = {
                "replayed": False,
                "claimed": grant,
                "gained": gained,
                "streak": int(player["streak_count"]),
                "longest": int(player["longest_streak"]),
                "points": int(player["points"]),
                "questsCompleted": quests,
                "achievementsUnlocked": achievements,
                "serverTime": iso(now),
            }
            store_idempotency(conn, player_id, "streak", key, response, now)
            return response


def link_wallet(pool, player_id: int, address: str, key: str, now: datetime) -> dict:
    require_key(key)
    if not valid_watch_address(address):
        raise GameError(
            "bad_address",
            "Address must be a canonical watch-only ZYN address: ZYN followed by 40 lowercase hex characters.",
            400,
        )
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "wallet", key)
            if replay:
                return replay
            reject_if_banned(player)
            if player["wallet_address"] == address:
                response = {
                    "replayed": False,
                    "linked": True,
                    "unchanged": True,
                    "address": address,
                    "serverTime": iso(now),
                }
                store_idempotency(conn, player_id, "wallet", key, response, now)
                return response
            enforce_wallet_churn(conn, player_id, now)
            claim = conn.execute(
                "SELECT player_id FROM wallet_claims WHERE address = %s FOR UPDATE",
                (address,),
            ).fetchone()
            if claim and int(claim["player_id"]) != player_id:
                raise GameError("address_taken", "That address is already linked to another operator.", 409)
            if claim is None:
                try:
                    with conn.transaction():
                        conn.execute(
                            "INSERT INTO wallet_claims (address, player_id, claimed_at) VALUES (%s, %s, %s)",
                            (address, player_id, now),
                        )
                except UniqueViolation as exc:
                    raise GameError("address_taken", "That address is already linked to another operator.", 409) from exc
            conn.execute(
                "UPDATE players SET wallet_address = %s, wallet_linked_at = %s WHERE id = %s",
                (address, now, player_id),
            )
            conn.execute(
                "INSERT INTO wallet_events (player_id, address, action, created_at) VALUES (%s, %s, 'link', %s)",
                (player_id, address, now),
            )
            levels = load_levels(conn, player_id)
            season = active_season(conn)
            player = reload_player(conn, player_id)
            quests, achievements = sync_rewards(conn, player, levels, now, season["id"] if season else None, include_quests=False)
            response = {
                "replayed": False,
                "linked": True,
                "unchanged": False,
                "address": address,
                "questsCompleted": quests,
                "achievementsUnlocked": achievements,
                "serverTime": iso(now),
            }
            store_idempotency(conn, player_id, "wallet", key, response, now)
            return response


def unlink_wallet(pool, player_id: int, key: str, now: datetime) -> dict:
    require_key(key)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "unlink", key)
            if replay:
                return replay
            reject_if_banned(player)
            address = player["wallet_address"]
            if not address:
                response = {"replayed": False, "linked": False, "serverTime": iso(now)}
                store_idempotency(conn, player_id, "unlink", key, response, now)
                return response
            enforce_wallet_churn(conn, player_id, now)
            conn.execute(
                "UPDATE players SET wallet_address = NULL, wallet_linked_at = NULL WHERE id = %s",
                (player_id,),
            )
            conn.execute(
                "INSERT INTO wallet_events (player_id, address, action, created_at) VALUES (%s, %s, 'unlink', %s)",
                (player_id, address, now),
            )
            response = {
                "replayed": False,
                "linked": False,
                "released": False,
                "note": "The address stays reserved to this operator so link rewards cannot be farmed.",
                "serverTime": iso(now),
            }
            store_idempotency(conn, player_id, "unlink", key, response, now)
            return response


def upgrades_view(pool, player_id: int, now: datetime) -> dict:
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            levels = load_levels(conn, player_id)
            player = persist_energy(conn, player, levels, now)
            modules = []
            for module in MODULE_ORDER:
                spec = MODULES[module]
                level = levels[module]
                nxt = None if level >= spec.max_level else upgrade_cost(module, level)
                modules.append(
                    {
                        "id": module,
                        "title": spec.title,
                        "summary": spec.summary,
                        "level": level,
                        "maxLevel": spec.max_level,
                        "nextCost": nxt,
                        "affordable": nxt is not None and int(player["points"]) >= nxt,
                    }
                )
            return {
                "points": int(player["points"]),
                "nodeLevel": node_level(levels),
                "networkPower": network_power(levels),
                "modules": modules,
            }


def quests_view(pool, player_id: int, now: datetime, *, claim: bool) -> dict:
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            levels = load_levels(conn, player_id)
            season = active_season(conn)
            newly: list[str] = []
            achievements: list[str] = []
            if claim:
                newly, achievements = sync_rewards(conn, player, levels, now, season["id"] if season else None)
                player = reload_player(conn, player_id)
            context = build_context(conn, player, levels, now)
            claimed = {
                (row["quest_id"], row["period_key"])
                for row in conn.execute(
                    "SELECT quest_id, period_key FROM quest_claims WHERE player_id = %s",
                    (player_id,),
                ).fetchall()
            }
            items = []
            for quest in QUESTS:
                key = period_key(quest.period, now.date())
                current = min(quest.target, int(context.get(quest.metric, 0)))
                items.append(
                    {
                        "id": quest.id,
                        "title": quest.title,
                        "description": quest.description,
                        "period": quest.period,
                        "current": current,
                        "target": quest.target,
                        "reward": quest_payout(quest.reward, levels["storage"]),
                        "complete": (quest.id, key) in claimed or current >= quest.target,
                        "claimed": (quest.id, key) in claimed,
                    }
                )
            return {
                "quests": items,
                "newlyCompleted": newly,
                "achievementsUnlocked": achievements,
                "points": int(player["points"]),
                "serverTime": iso(now),
            }


def achievements_view(pool, player_id: int) -> dict:
    with pool.connection() as conn:
        player = reload_player(conn, player_id)
        levels = load_levels(conn, player_id)
        unlocked = {
            row["achievement_id"]: row["created_at"]
            for row in conn.execute(
                "SELECT achievement_id, created_at FROM player_achievements WHERE player_id = %s",
                (player_id,),
            ).fetchall()
        }
        context = build_context(conn, player, levels, datetime.now(timezone.utc))
        items = []
        for item in ACHIEVEMENTS:
            items.append(
                {
                    "id": item.id,
                    "title": item.title,
                    "description": item.description,
                    "reward": item.reward,
                    "target": item.target,
                    "current": min(item.target, int(context.get(item.metric, 0))),
                    "unlocked": item.id in unlocked,
                    "unlockedAt": iso(unlocked.get(item.id)),
                }
            )
        return {"achievements": items}


def leaderboard_view(pool, player_id: int, board: str, now: datetime, limit: int = 20) -> dict:
    if board not in {"daily", "weekly", "season", "alltime"}:
        raise GameError("bad_board", "Leaderboard must be daily, weekly, season, or alltime.", 400)
    with pool.connection() as conn:
        season = active_season(conn)
        extra, params = score_filter(board, now, season)
        query = f"""
            WITH scores AS (
                SELECT player_id, SUM(amount)::bigint AS score
                FROM point_ledger
                WHERE amount > 0 {extra}
                GROUP BY player_id
            )
            SELECT s.score, p.id, p.display_name, p.node_level, p.referral_code
            FROM scores s
            JOIN players p ON p.id = s.player_id
            ORDER BY s.score DESC, p.id ASC
            LIMIT %s
        """
        rows = conn.execute(query, (*params, limit)).fetchall()
        score, rank = score_and_rank(conn, player_id, extra, params)
    return {
        "board": board,
        "entries": [
            {
                "rank": index,
                "playerId": int(row["id"]),
                "displayName": row["display_name"] or f"Node {row['id']}",
                "nodeLevel": int(row["node_level"]),
                "score": int(row["score"]),
                "you": int(row["id"]) == player_id,
            }
            for index, row in enumerate(rows, start=1)
        ],
        "me": {"rank": rank, "score": score},
        "serverTime": iso(now),
    }


def observe_chain(pool, player_id: int, panel: dict, now: datetime) -> dict:
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            markers = panel.get("markers") if isinstance(panel.get("markers"), dict) else {}
            record_markers(conn, player_id, markers, now)
            levels = load_levels(conn, player_id)
            season = active_season(conn)
            quests, achievements = ([], [])
            if not player["banned"]:
                quests, achievements = sync_rewards(conn, player, levels, now, season["id"] if season else None, include_quests=False)
            public = {key: value for key, value in panel.items() if key != "markers"}
            public["questsCompleted"] = quests
            public["achievementsUnlocked"] = achievements
            public["serverTime"] = iso(now)
            return public


def export_snapshot(pool, actor: str, now: datetime) -> dict:
    with pool.connection() as conn:
        with conn.transaction():
            season = active_season(conn) or conn.execute(
                "SELECT * FROM seasons ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if season is None:
                raise GameError("no_season", "No season exists to snapshot.", 409)
            rows = conn.execute(
                """
                SELECT p.id, p.referral_code, p.node_level, p.cycle_count, p.longest_streak,
                       COALESCE(SUM(l.amount) FILTER (WHERE l.amount > 0), 0)::bigint AS season_points
                FROM players p
                LEFT JOIN point_ledger l ON l.player_id = p.id AND l.season_id = %s
                GROUP BY p.id
                HAVING COALESCE(SUM(l.amount) FILTER (WHERE l.amount > 0), 0) > 0
                ORDER BY season_points DESC, p.id ASC
                LIMIT 5000
                """,
                (season["id"],),
            ).fetchall()
            payload = {
                "kind": "zyron-node-season-snapshot",
                "version": 1,
                "season": {
                    "id": int(season["id"]),
                    "name": season["name"],
                    "status": season["status"],
                    "startsAt": iso(season["starts_at"]),
                    "endsAt": iso(season["ends_at"]),
                },
                "exportedAt": iso(now),
                "note": POINTS_NOTICE + " This snapshot is not a payout and does not transfer ZYN or Zyrum.",
                "conversionRate": None,
                "automaticPayout": False,
                "truncated": len(rows) >= 5000,
                "standings": [
                    {
                        "rank": index,
                        "playerId": int(row["id"]),
                        "referralCode": row["referral_code"],
                        "nodeLevel": int(row["node_level"]),
                        "seasonPoints": int(row["season_points"]),
                        "cycleCount": int(row["cycle_count"]),
                        "longestStreak": int(row["longest_streak"]),
                    }
                    for index, row in enumerate(rows, start=1)
                ],
            }
            stored = conn.execute(
                """
                INSERT INTO season_snapshots (season_id, created_at, note, payload)
                VALUES (%s, %s, %s, %s)
                RETURNING id
                """,
                (season["id"], now, payload["note"], Json(payload)),
            ).fetchone()
            audit(conn, actor, "season.snapshot", {"snapshotId": int(stored["id"]), "seasonId": int(season["id"])}, now)
            payload["snapshotId"] = int(stored["id"])
            return payload


def close_season(pool, actor: str, now: datetime) -> dict:
    with pool.connection() as conn:
        with conn.transaction():
            season = active_season(conn)
            if season is None:
                raise GameError("no_active_season", "There is no active season to close.", 409)
            conn.execute(
                "UPDATE seasons SET status = 'closed', ends_at = %s WHERE id = %s AND status = 'active'",
                (now, season["id"]),
            )
            audit(conn, actor, "season.close", {"seasonId": int(season["id"]), "payout": False}, now)
            return {
                "id": int(season["id"]),
                "name": season["name"],
                "status": "closed",
                "endsAt": iso(now),
                "payout": False,
                "note": "Season closed. No ZYN or Zyrum was transferred.",
            }


def admin_overview(pool) -> dict:
    with pool.connection() as conn:
        counts = conn.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM players) AS players,
                (SELECT COUNT(*) FROM players WHERE banned) AS banned,
                (SELECT COALESCE(SUM(points), 0) FROM players) AS points_outstanding,
                (SELECT COUNT(*) FROM abuse_flags WHERE resolved_at IS NULL) AS open_flags,
                (SELECT COUNT(*) FROM referrals WHERE status = 'rewarded') AS qualified_referrals
            """
        ).fetchone()
        season = active_season(conn)
        flags = conn.execute(
            """
            SELECT id, player_id, code, detail, weight, created_at
            FROM abuse_flags
            WHERE resolved_at IS NULL
            ORDER BY id DESC
            LIMIT 25
            """
        ).fetchall()
    return {
        "players": int(counts["players"]),
        "banned": int(counts["banned"]),
        "pointsOutstanding": int(counts["points_outstanding"]),
        "openFlags": int(counts["open_flags"]),
        "qualifiedReferrals": int(counts["qualified_referrals"]),
        "season": None
        if season is None
        else {"id": int(season["id"]), "name": season["name"], "status": season["status"]},
        "flags": [
            {
                "id": int(row["id"]),
                "playerId": None if row["player_id"] is None else int(row["player_id"]),
                "code": row["code"],
                "detail": row["detail"],
                "weight": int(row["weight"]),
                "createdAt": iso(row["created_at"]),
            }
            for row in flags
        ],
        "notice": POINTS_NOTICE,
    }


def admin_search(pool, query: str) -> dict:
    query = query.strip()[:64]
    if len(query) < 2:
        raise GameError("bad_query", "Enter at least 2 characters.", 400)
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT id, telegram_id, username, display_name, referral_code, points, node_level,
                   banned, abuse_score, wallet_address, created_at
            FROM players
            WHERE telegram_id::text = %s
               OR referral_code = %s
               OR username ILIKE %s
            ORDER BY id ASC
            LIMIT 30
            """,
            (query, query.upper(), query if query.startswith("@") else query),
        ).fetchall()
        if not rows and query.replace("@", "").isalnum():
            rows = conn.execute(
                """
                SELECT id, telegram_id, username, display_name, referral_code, points, node_level,
                       banned, abuse_score, wallet_address, created_at
                FROM players
                WHERE username ILIKE %s
                ORDER BY id ASC
                LIMIT 30
                """,
                (query.lstrip("@") + "%",),
            ).fetchall()
    return {"players": [public_admin_player(row) for row in rows]}


def set_ban(pool, player_id: int, banned: bool, actor: str, now: datetime) -> dict:
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            conn.execute("UPDATE players SET banned = %s WHERE id = %s", (banned, player_id))
            audit(conn, actor, "player.ban" if banned else "player.unban", {"playerId": player_id}, now)
            player = reload_player(conn, player_id)
            return public_admin_player(player)


def resolve_flag(pool, flag_id: int, actor: str, now: datetime) -> dict:
    with pool.connection() as conn:
        with conn.transaction():
            row = conn.execute(
                """
                UPDATE abuse_flags
                SET resolved_at = %s
                WHERE id = %s AND resolved_at IS NULL
                RETURNING id, player_id, weight
                """,
                (now, flag_id),
            ).fetchone()
            if row is None:
                raise GameError("not_found", "Flag not found.", 404)
            if row["player_id"] is not None and int(row["weight"]) > 0:
                conn.execute(
                    """
                    UPDATE players
                    SET abuse_score = GREATEST(0, abuse_score - %s)
                    WHERE id = %s
                    """,
                    (int(row["weight"]), row["player_id"]),
                )
            audit(conn, actor, "flag.resolve", {"flagId": flag_id}, now)
            return {"id": flag_id, "resolved": True}


def release_wallet_claim(pool, address: str, actor: str, now: datetime) -> dict:
    if not valid_watch_address(address):
        raise GameError("bad_address", "Address is not a canonical ZYN address.", 400)
    with pool.connection() as conn:
        with conn.transaction():
            conn.execute("DELETE FROM wallet_claims WHERE address = %s", (address,))
            conn.execute("UPDATE players SET wallet_address = NULL, wallet_linked_at = NULL WHERE wallet_address = %s", (address,))
            audit(conn, actor, "wallet.release", {"address": address}, now)
            return {"address": address, "released": True}


def list_snapshots(pool) -> dict:
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT id, season_id, created_at
            FROM season_snapshots
            ORDER BY id DESC
            LIMIT 20
            """
        ).fetchall()
    return {
        "snapshots": [
            {"id": int(row["id"]), "seasonId": int(row["season_id"]), "createdAt": iso(row["created_at"])}
            for row in rows
        ]
    }


def get_snapshot(pool, snapshot_id: int) -> dict:
    with pool.connection() as conn:
        row = conn.execute("SELECT payload FROM season_snapshots WHERE id = %s", (snapshot_id,)).fetchone()
    if row is None:
        raise GameError("not_found", "Snapshot not found.", 404)
    payload = row["payload"]
    if not isinstance(payload, dict):
        raise GameError("bad_snapshot", "Snapshot payload is unreadable.", 500)
    return payload


def remember_pending_referral(pool, telegram_id: int, code: str, now: datetime) -> None:
    if any(ch not in ALPHABET for ch in code) or len(code) != 8:
        return
    with pool.connection() as conn:
        with conn.transaction():
            conn.execute(
                """
                INSERT INTO pending_referrals (telegram_id, referral_code, created_at)
                VALUES (%s, %s, %s)
                ON CONFLICT (telegram_id)
                DO UPDATE SET referral_code = EXCLUDED.referral_code, created_at = EXCLUDED.created_at
                """,
                (telegram_id, code, now),
            )


def ensure_player(conn, identity, ip_hash: str | None, now: datetime) -> dict:
    existing = conn.execute(
        "SELECT * FROM players WHERE telegram_id = %s FOR UPDATE",
        (identity.id,),
    ).fetchone()
    if existing:
        conn.execute(
            """
            UPDATE players
            SET username = %s, display_name = %s, last_seen_at = %s
            WHERE id = %s
            """,
            (identity.username, identity.display_name or existing["display_name"], now, existing["id"]),
        )
        player = reload_player(conn, existing["id"])
        maybe_attach_referral(conn, player, identity.start_param, ip_hash, now, fresh=False)
        return reload_player(conn, existing["id"])

    start_param = identity.start_param
    if not start_param:
        pending = conn.execute(
            "SELECT referral_code FROM pending_referrals WHERE telegram_id = %s",
            (identity.id,),
        ).fetchone()
        if pending:
            start_param = "ref_" + pending["referral_code"]

    player = insert_player(conn, identity, ip_hash, now)
    conn.execute("DELETE FROM pending_referrals WHERE telegram_id = %s", (identity.id,))
    add_signup_burst_if_needed(conn, player, ip_hash, now)
    maybe_attach_referral(conn, player, start_param, ip_hash, now, fresh=True)
    return reload_player(conn, player["id"])


def insert_player(conn, identity, ip_hash: str | None, now: datetime) -> dict:
    code = new_referral_code()
    for _ in range(6):
        try:
            with conn.transaction():
                player = conn.execute(
                    """
                    INSERT INTO players (
                        telegram_id, username, display_name, referral_code, points, lifetime_points,
                        energy, energy_updated_at, signup_ip_hash, created_at, last_seen_at, node_level
                    )
                    VALUES (%s, %s, %s, %s, 0, 0, %s, %s, %s, %s, %s, 1)
                    RETURNING *
                    """,
                    (
                        identity.id,
                        identity.username,
                        identity.display_name or "Operator",
                        code,
                        max_energy(empty_levels()),
                        now,
                        ip_hash,
                        now,
                        now,
                    ),
                ).fetchone()
                for module in MODULE_ORDER:
                    conn.execute(
                        "INSERT INTO player_upgrades (player_id, module, level) VALUES (%s, %s, 0)",
                        (player["id"], module),
                    )
            return player
        except UniqueViolation:
            existing = conn.execute(
                "SELECT * FROM players WHERE telegram_id = %s FOR UPDATE",
                (identity.id,),
            ).fetchone()
            if existing:
                return existing
            code = new_referral_code()
    raise GameError("create_failed", "Could not create the operator profile.", 500)


def maybe_attach_referral(conn, player, start_param: str | None, ip_hash: str | None, now: datetime, *, fresh: bool) -> None:
    if player["referred_by_id"] is not None or not start_param:
        return
    if not fresh and now - player["created_at"] > timedelta(minutes=30):
        return
    code = referral_code_from_param(start_param)
    if not code or code == player["referral_code"]:
        return
    if conn.execute("SELECT 1 FROM referrals WHERE referee_id = %s", (player["id"],)).fetchone():
        return
    referrer = conn.execute("SELECT * FROM players WHERE referral_code = %s FOR UPDATE", (code,)).fetchone()
    if referrer is None or int(referrer["id"]) == int(player["id"]):
        return
    if int(referrer.get("referred_by_id") or 0) == int(player["id"]):
        add_flag(conn, player["id"], "mutual_referral", "Mutual referral was refused.", 40, now)
        return
    status = "pending"
    if referrer["banned"] or has_open_flag(conn, player["id"], "signup_burst"):
        status = "rejected"
    conn.execute(
        "UPDATE players SET referred_by_id = %s WHERE id = %s AND referred_by_id IS NULL",
        (referrer["id"], player["id"]),
    )
    conn.execute(
        """
        INSERT INTO referrals (referrer_id, referee_id, status, created_at)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (referee_id) DO NOTHING
        """,
        (referrer["id"], player["id"], status, now),
    )
    if ip_hash and ip_hash == referrer["signup_ip_hash"]:
        add_flag(conn, player["id"], "same_ip_referral", "Referral shares a signup network hash.", 15, now)
        add_flag(conn, referrer["id"], "same_ip_referral", "Referral shares a signup network hash.", 15, now)


def qualify_referral(conn, player_id: int, now: datetime, min_cycles: int, min_age: int, season_id: int | None) -> bool:
    referral = conn.execute(
        "SELECT * FROM referrals WHERE referee_id = %s FOR UPDATE",
        (player_id,),
    ).fetchone()
    if referral is None or referral["status"] != "pending":
        return False
    player = reload_player(conn, player_id)
    age = (now - player["created_at"]).total_seconds()
    if int(player["cycle_count"]) < min_cycles or age < min_age:
        return False
    if player["banned"]:
        conn.execute("UPDATE referrals SET status = 'rejected' WHERE id = %s", (referral["id"],))
        return False
    referrer = conn.execute(
        "SELECT * FROM players WHERE id = %s FOR UPDATE",
        (referral["referrer_id"],),
    ).fetchone()
    if referrer is None or referrer["banned"] or int(referrer["abuse_score"]) >= ABUSE_REFERRAL_BLOCK or int(player["abuse_score"]) >= ABUSE_REFERRAL_BLOCK:
        conn.execute("UPDATE referrals SET status = 'rejected' WHERE id = %s", (referral["id"],))
        return False
    paid = conn.execute(
        """
        SELECT COUNT(*) AS n
        FROM referrals
        WHERE referrer_id = %s AND status = 'rewarded' AND rewarded_at >= %s
        """,
        (referrer["id"], now - timedelta(days=7)),
    ).fetchone()
    if int(paid["n"]) >= REFERRAL_WEEKLY_CAP:
        conn.execute("UPDATE referrals SET status = 'rejected' WHERE id = %s", (referral["id"],))
        add_flag(conn, referrer["id"], "referral_cap", "Weekly rewarded-referral cap reached.", 0, now)
        return False
    apply_points(
        conn,
        int(referrer["id"]),
        REFERRER_REWARD,
        "referral_referrer",
        f"referral:referrer:{referral['id']}",
        season_id,
        now,
    )
    apply_points(
        conn,
        player_id,
        REFEREE_REWARD,
        "referral_referee",
        f"referral:referee:{referral['id']}",
        season_id,
        now,
    )
    conn.execute(
        "UPDATE referrals SET status = 'rewarded', rewarded_at = %s WHERE id = %s",
        (now, referral["id"]),
    )
    return True


def chests_view(pool, player_id: int, now: datetime) -> dict:
    with pool.connection() as conn:
        player = reload_player(conn, player_id)
        levels = load_levels(conn, player_id)
        return assemble_chests(conn, player, levels, now)


def open_chest(pool, player_id: int, chest_id: str, now: datetime) -> dict:
    if not CHEST_ID_RE.fullmatch(chest_id or ""):
        raise GameError("bad_chest", "Unknown supply chest.", 400)
    if chest_id == "daily":
        return open_daily_chest(pool, player_id, now)
    if chest_id.startswith("quest:"):
        return open_quest_chest(pool, player_id, chest_id, now)
    return open_level_chest(pool, player_id, chest_id, now)


def open_daily_chest(pool, player_id: int, now: datetime) -> dict:
    result = claim_streak(pool, player_id, now)
    points, lifetime = balances(pool, player_id)
    replayed = bool(result["replayed"])
    return {
        "id": "daily",
        "kind": "daily",
        "title": "Daily supply",
        "detail": f"Streak day {result['streak']}",
        "replayed": replayed,
        "opened": True,
        "gained": 0 if replayed else int(result["gained"]),
        "points": points,
        "lifetimePoints": lifetime,
        "achievementsUnlocked": [] if replayed else list(result.get("achievementsUnlocked") or []),
        "serverTime": iso(now),
    }


def open_quest_chest(pool, player_id: int, chest_id: str, now: datetime) -> dict:
    quest_id = chest_id.split(":", 1)[1]
    quest = QUESTS_BY_ID.get(quest_id)
    if quest is None:
        raise GameError("bad_chest", "Unknown supply chest.", 400)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            reject_if_banned(player)
            levels = load_levels(conn, player_id)
            key = period_key(quest.period, now.date())
            existing = conn.execute(
                "SELECT reward_points FROM quest_claims WHERE player_id = %s AND quest_id = %s AND period_key = %s",
                (player_id, quest.id, key),
            ).fetchone()
            if existing:
                player = reload_player(conn, player_id)
                return chest_result(
                    chest_id,
                    "quest",
                    quest.title,
                    quest.description,
                    replayed=True,
                    gained=0,
                    points=int(player["points"]),
                    lifetime=int(player["lifetime_points"]),
                    achievements=[],
                    now=now,
                )
            context = build_context(conn, player, levels, now)
            if int(context.get(quest.metric, 0)) < quest.target:
                raise GameError("chest_sealed", "That supply chest is not ready yet.", 409)
            payout = quest_payout(quest.reward, levels["storage"])
            season = active_season(conn)
            season_id = season["id"] if season else None
            apply_points(conn, player_id, payout, "quest", f"quest:{player_id}:{quest.id}:{key}", season_id, now)
            conn.execute(
                """
                INSERT INTO quest_claims (player_id, quest_id, period_key, reward_points, created_at)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT DO NOTHING
                """,
                (player_id, quest.id, key, payout, now),
            )
            player = reload_player(conn, player_id)
            _quests, achievements = sync_rewards(conn, player, levels, now, season_id, include_quests=False)
            player = reload_player(conn, player_id)
            return chest_result(
                chest_id,
                "quest",
                quest.title,
                quest.description,
                replayed=False,
                gained=payout,
                points=int(player["points"]),
                lifetime=int(player["lifetime_points"]),
                achievements=achievements,
                now=now,
            )


def open_level_chest(pool, player_id: int, chest_id: str, now: datetime) -> dict:
    level = int(chest_id.split(":", 1)[1])
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            reject_if_banned(player)
            levels = load_levels(conn, player_id)
            current = node_level(levels)
            if level < 2 or level > current:
                raise GameError("chest_sealed", "Reach that node level to unseal this chest.", 409)
            existing = conn.execute(
                "SELECT reward_points FROM chest_claims WHERE player_id = %s AND chest_id = %s",
                (player_id, chest_id),
            ).fetchone()
            if existing:
                player = reload_player(conn, player_id)
                return chest_result(
                    chest_id,
                    "level",
                    f"Level {level} supply",
                    "Already collected.",
                    replayed=True,
                    gained=0,
                    points=int(player["points"]),
                    lifetime=int(player["lifetime_points"]),
                    achievements=[],
                    now=now,
                )
            reward = level_chest_reward(level)
            season = active_season(conn)
            season_id = season["id"] if season else None
            apply_points(conn, player_id, reward, "chest", f"chest:{player_id}:level:{level}", season_id, now)
            conn.execute(
                """
                INSERT INTO chest_claims (player_id, chest_id, reward_points, created_at)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT DO NOTHING
                """,
                (player_id, chest_id, reward, now),
            )
            player = reload_player(conn, player_id)
            _quests, achievements = sync_rewards(conn, player, levels, now, season_id, include_quests=False)
            player = reload_player(conn, player_id)
            return chest_result(
                chest_id,
                "level",
                f"Level {level} supply",
                "Node level milestone. Zyron Points only.",
                replayed=False,
                gained=reward,
                points=int(player["points"]),
                lifetime=int(player["lifetime_points"]),
                achievements=achievements,
                now=now,
            )


def assemble_chests(conn, player, levels: dict[str, int], now: datetime) -> dict:
    context = build_context(conn, player, levels, now)
    claimed = {
        (row["quest_id"], row["period_key"])
        for row in conn.execute(
            "SELECT quest_id, period_key FROM quest_claims WHERE player_id = %s",
            (player["id"],),
        ).fetchall()
    }
    opened_levels = {
        row["chest_id"]: int(row["reward_points"])
        for row in conn.execute(
            "SELECT chest_id, reward_points FROM chest_claims WHERE player_id = %s",
            (player["id"],),
        ).fetchall()
    }
    ready: list[dict] = []
    sealed: list[dict] = []
    opened: list[dict] = []
    claimed_today = player["streak_last_date"] == now.date()
    projected, _grant = advance_streak(player["streak_last_date"], int(player["streak_count"]), now.date())
    streak_day = int(player["streak_count"]) if claimed_today else projected
    daily_reward = streak_reward(int(player["streak_count"])) if claimed_today else streak_reward(projected)
    daily = chest_card(
        "daily",
        "daily",
        "Daily supply",
        f"Login streak · day {streak_day}",
        daily_reward,
        ready=not claimed_today,
        opened=claimed_today,
        current=1 if claimed_today else 0,
        target=1,
        tag="Streak",
    )
    (opened if claimed_today else ready).append(daily)
    for quest in QUESTS:
        key = period_key(quest.period, now.date())
        current = min(quest.target, int(context.get(quest.metric, 0)))
        payout = quest_payout(quest.reward, levels["storage"])
        card = chest_card(
            f"quest:{quest.id}",
            "quest",
            quest.title,
            quest.description,
            payout,
            ready=current >= quest.target and (quest.id, key) not in claimed,
            opened=(quest.id, key) in claimed,
            current=current,
            target=quest.target,
            tag=quest.period.capitalize(),
        )
        if card["opened"]:
            opened.append(card)
        elif card["ready"]:
            ready.append(card)
        else:
            sealed.append(card)
    current_level = node_level(levels)
    for level in range(2, current_level + 1):
        chest_id = f"level:{level}"
        reward = opened_levels.get(chest_id, level_chest_reward(level))
        card = chest_card(
            chest_id,
            "level",
            f"Level {level} supply",
            "One-time node level reward. Zyron Points only.",
            reward,
            ready=chest_id not in opened_levels,
            opened=chest_id in opened_levels,
            current=level,
            target=level,
            tag="Level",
        )
        (opened if card["opened"] else ready).append(card)
    total = sum(levels.values())
    max_total = sum(spec.max_level for spec in MODULES.values())
    if total < max_total:
        into = total % 4
        next_level = current_level + 1
        sealed.append(
            chest_card(
                f"level:{next_level}",
                "level",
                f"Level {next_level} supply",
                "Four module levels raise the node one rank.",
                level_chest_reward(next_level),
                ready=False,
                opened=False,
                current=into,
                target=4,
                tag="Level",
            )
        )
    sealed.sort(key=lambda item: (item["current"] / item["target"] if item["target"] else 0), reverse=True)
    return {
        "ready": ready,
        "sealed": sealed,
        "opened": opened[:16],
        "serverTime": iso(now),
    }


def chest_card(
    chest_id: str,
    kind: str,
    title: str,
    detail: str,
    reward: int,
    *,
    ready: bool,
    opened: bool,
    current: int,
    target: int,
    tag: str,
) -> dict:
    return {
        "id": chest_id,
        "kind": kind,
        "title": title,
        "detail": detail,
        "reward": int(reward),
        "ready": bool(ready),
        "opened": bool(opened),
        "current": int(current),
        "target": int(target),
        "tag": tag,
    }


def chest_result(
    chest_id: str,
    kind: str,
    title: str,
    detail: str,
    *,
    replayed: bool,
    gained: int,
    points: int,
    lifetime: int,
    achievements: list[str],
    now: datetime,
) -> dict:
    bonus = 0
    for item_id in achievements:
        spec = ACHIEVEMENTS_BY_ID.get(item_id)
        if spec is not None:
            bonus += spec.reward
    return {
        "id": chest_id,
        "kind": kind,
        "title": title,
        "detail": detail,
        "replayed": replayed,
        "opened": True,
        "gained": int(gained),
        "achievementPoints": bonus,
        "points": int(points),
        "lifetimePoints": int(lifetime),
        "achievementsUnlocked": list(achievements),
        "serverTime": iso(now),
    }


def balances(pool, player_id: int) -> tuple[int, int]:
    with pool.connection() as conn:
        row = conn.execute("SELECT points, lifetime_points FROM players WHERE id = %s", (player_id,)).fetchone()
    if row is None:
        raise GameError("not_found", "Operator not found.", 404)
    return int(row["points"]), int(row["lifetime_points"])


def sync_rewards(
    conn,
    player,
    levels: dict[str, int],
    now: datetime,
    season_id: int | None,
    *,
    include_quests: bool = True,
) -> tuple[list[str], list[str]]:
    if player["banned"]:
        return [], []
    context = build_context(conn, player, levels, now)
    quests_done: list[str] = []
    if not include_quests:
        player = reload_player(conn, player["id"])
        context = build_context(conn, player, levels, now)
        return [], _grant_achievements(conn, player, levels, context, season_id, now)
    for quest in QUESTS:
        key = period_key(quest.period, now.date())
        if conn.execute(
            "SELECT 1 FROM quest_claims WHERE player_id = %s AND quest_id = %s AND period_key = %s",
            (player["id"], quest.id, key),
        ).fetchone():
            continue
        if int(context.get(quest.metric, 0)) < quest.target:
            continue
        payout = quest_payout(quest.reward, levels["storage"])
        apply_points(conn, int(player["id"]), payout, "quest", f"quest:{player['id']}:{quest.id}:{key}", season_id, now)
        conn.execute(
            """
            INSERT INTO quest_claims (player_id, quest_id, period_key, reward_points, created_at)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (player["id"], quest.id, key, payout, now),
        )
        quests_done.append(quest.id)
    player = reload_player(conn, player["id"])
    context = build_context(conn, player, levels, now)
    return quests_done, _grant_achievements(conn, player, levels, context, season_id, now)


def _grant_achievements(conn, player, levels: dict[str, int], context: dict[str, int], season_id: int | None, now: datetime) -> list[str]:
    achievements_done: list[str] = []
    for item in ACHIEVEMENTS:
        if conn.execute(
            "SELECT 1 FROM player_achievements WHERE player_id = %s AND achievement_id = %s",
            (player["id"], item.id),
        ).fetchone():
            continue
        if int(context.get(item.metric, 0)) < item.target:
            continue
        apply_points(
            conn,
            int(player["id"]),
            item.reward,
            "achievement",
            f"achievement:{player['id']}:{item.id}",
            season_id,
            now,
        )
        conn.execute(
            """
            INSERT INTO player_achievements (player_id, achievement_id, created_at)
            VALUES (%s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (player["id"], item.id, now),
        )
        achievements_done.append(item.id)
    return achievements_done


def build_context(conn, player, levels: dict[str, int], now: datetime) -> dict[str, int]:
    start, end = utc_day_bounds(now)
    cycles_today = conn.execute(
        """
        SELECT COUNT(*) AS n
        FROM point_ledger
        WHERE player_id = %s AND reason = 'cycle' AND created_at >= %s AND created_at < %s
        """,
        (player["id"], start, end),
    ).fetchone()["n"]
    qualified = conn.execute(
        "SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = %s AND status = 'rewarded'",
        (player["id"],),
    ).fetchone()["n"]
    today_key = now.date().isoformat()
    markers = {
        f"{row['marker']}:{row['period_key']}"
        for row in conn.execute(
            "SELECT marker, period_key FROM player_markers WHERE player_id = %s",
            (player["id"],),
        ).fetchall()
    }
    return {
        "streak_claimed_today": 1 if player["streak_last_date"] == now.date() else 0,
        "cycles_today": int(cycles_today),
        "chain_status_today": 1 if f"chain_status:{today_key}" in markers else 0,
        "upgrade_total": sum(levels.values()),
        "wallet_linked": 1 if player["wallet_address"] else 0,
        "chain_wallet_once": 1 if "chain_wallet:once" in markers else 0,
        "qualified_referrals": int(qualified),
        "network_power": network_power(levels),
        "cycle_count": int(player["cycle_count"]),
        "longest_streak": int(player["longest_streak"]),
    }


def build_profile(conn, player, levels: dict[str, int], now: datetime, bot_username: str) -> dict:
    season = active_season(conn)
    ranks = {}
    for board in ("daily", "weekly", "season", "alltime"):
        extra, params = score_filter(board, now, season)
        score, rank = score_and_rank(conn, int(player["id"]), extra, params)
        ranks[board] = {"rank": rank, "score": score}
    invited = conn.execute(
        "SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = %s",
        (player["id"],),
    ).fetchone()["n"]
    qualified = conn.execute(
        "SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = %s AND status = 'rewarded'",
        (player["id"],),
    ).fetchone()["n"]
    claimed_today = player["streak_last_date"] == now.date()
    projected, _ = advance_streak(player["streak_last_date"], int(player["streak_count"]), now.date())
    upcoming = streak_reward(int(player["streak_count"]) + 1) if claimed_today else streak_reward(projected)
    return {
        "player": {
            "id": int(player["id"]),
            "displayName": player["display_name"] or "Operator",
            "username": player["username"],
            "level": node_level(levels),
            "points": int(player["points"]),
            "lifetimePoints": int(player["lifetime_points"]),
            "networkPower": network_power(levels),
            "cycleReward": cycle_reward(levels, int(player["streak_count"])),
            "cycleCount": int(player["cycle_count"]),
            "energy": energy_view(player, levels, now),
            "streak": {
                "count": int(player["streak_count"]),
                "longest": int(player["longest_streak"]),
                "claimedToday": claimed_today,
                "nextReward": upcoming,
                "calendar": list(STREAK_CALENDAR),
            },
            "walletAddress": player["wallet_address"],
            "banned": bool(player["banned"]),
            "rank": ranks,
            "referral": {
                "code": player["referral_code"],
                "link": invite_link(bot_username, player["referral_code"]),
                "invited": int(invited),
                "qualified": int(qualified),
            },
        },
        "season": None
        if season is None
        else {
            "id": int(season["id"]),
            "name": season["name"],
            "status": season["status"],
            "startsAt": iso(season["starts_at"]),
            "endsAt": iso(season["ends_at"]),
        },
        "serverTime": iso(now),
        "notices": [POINTS_NOTICE],
    }


STREAK_CALENDAR = STREAK_REWARDS[1:]


def record_markers(conn, player_id: int, markers: dict, now: datetime) -> None:
    today = now.date().isoformat()
    wanted = []
    if markers.get("chain_status"):
        wanted.append(("chain_status", today))
    if markers.get("chain_blocks"):
        wanted.append(("chain_blocks", today))
    if markers.get("chain_wallet"):
        wanted.append(("chain_wallet", "once"))
    for marker, key in wanted:
        conn.execute(
            """
            INSERT INTO player_markers (player_id, marker, period_key, created_at)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (player_id, marker, key, now),
        )


def persist_energy(conn, player, levels: dict[str, int], now: datetime):
    current, updated_at = apply_energy(int(player["energy"]), player["energy_updated_at"], now, levels)
    if current != int(player["energy"]) or updated_at != player["energy_updated_at"]:
        conn.execute(
            "UPDATE players SET energy = %s, energy_updated_at = %s WHERE id = %s",
            (current, updated_at, player["id"]),
        )
        player = reload_player(conn, player["id"])
    return player


def energy_view(player, levels: dict[str, int], now: datetime) -> dict:
    current = int(player["energy"])
    cap = max_energy(levels)
    nxt = seconds_until_next_energy(current, player["energy_updated_at"], now, levels)
    next_at = None if current >= cap or nxt <= 0 else iso(now + timedelta(seconds=nxt))
    return {
        "current": current,
        "max": cap,
        "regenSeconds": regen_interval_seconds(levels),
        "nextInSeconds": nxt,
        "nextAt": next_at,
    }


def apply_points(conn, player_id: int, amount: int, reason: str, idempotency_key: str, season_id: int | None, now: datetime) -> None:
    if amount == 0:
        raise GameError("bad_amount", "Point change cannot be zero.", 500)
    inserted = conn.execute(
        """
        INSERT INTO point_ledger (player_id, amount, reason, idempotency_key, season_id, created_at)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
        """,
        (player_id, amount, reason, idempotency_key, season_id, now),
    ).fetchone()
    if inserted is None:
        return
    if amount > 0:
        conn.execute(
            """
            UPDATE players
            SET points = points + %s, lifetime_points = lifetime_points + %s
            WHERE id = %s
            """,
            (amount, amount, player_id),
        )
        return
    updated = conn.execute(
        """
        UPDATE players
        SET points = points + %s
        WHERE id = %s AND points + %s >= 0
        RETURNING points
        """,
        (amount, player_id, amount),
    ).fetchone()
    if updated is None:
        raise GameError("insufficient_points", "Not enough Zyron Points for that upgrade.", 409)


def load_levels(conn, player_id: int) -> dict[str, int]:
    levels = empty_levels()
    rows = conn.execute(
        "SELECT module, level FROM player_upgrades WHERE player_id = %s",
        (player_id,),
    ).fetchall()
    for row in rows:
        if row["module"] in levels:
            levels[row["module"]] = int(row["level"])
    return levels


def lock_player(conn, player_id: int) -> dict:
    row = conn.execute("SELECT * FROM players WHERE id = %s FOR UPDATE", (player_id,)).fetchone()
    if row is None:
        raise GameError("not_found", "Operator not found.", 404)
    return row


def reload_player(conn, player_id: int) -> dict:
    row = conn.execute("SELECT * FROM players WHERE id = %s", (player_id,)).fetchone()
    if row is None:
        raise GameError("not_found", "Operator not found.", 404)
    return row


def active_season(conn):
    return conn.execute(
        "SELECT * FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1"
    ).fetchone()


def replay_of(conn, player_id: int, scope: str, key: str) -> dict | None:
    row = conn.execute(
        "SELECT response FROM idempotency_keys WHERE player_id = %s AND scope = %s AND key = %s",
        (player_id, scope, key),
    ).fetchone()
    if row is None:
        return None
    payload = dict(row["response"])
    payload["replayed"] = True
    return payload


def store_idempotency(conn, player_id: int, scope: str, key: str, response: dict, now: datetime) -> None:
    conn.execute(
        """
        INSERT INTO idempotency_keys (player_id, scope, key, response, created_at)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT DO NOTHING
        """,
        (player_id, scope, key, Json(response), now),
    )


def add_signup_burst_if_needed(conn, player, ip_hash: str | None, now: datetime) -> None:
    if not ip_hash:
        return
    count = conn.execute(
        "SELECT COUNT(*) AS n FROM players WHERE signup_ip_hash = %s AND created_at >= %s",
        (ip_hash, now - timedelta(hours=1)),
    ).fetchone()["n"]
    if int(count) >= 6:
        add_flag(conn, player["id"], "signup_burst", "Many accounts from one network within an hour.", 25, now)


def enforce_wallet_churn(conn, player_id: int, now: datetime) -> None:
    count = conn.execute(
        "SELECT COUNT(*) AS n FROM wallet_events WHERE player_id = %s AND created_at >= %s",
        (player_id, now - timedelta(hours=24)),
    ).fetchone()["n"]
    if int(count) >= 4:
        add_flag(conn, player_id, "wallet_churn", "Too many wallet link changes in 24 hours.", 20, now)
        raise GameError("wallet_limited", "Wallet changes are limited for 24 hours.", 429)


def add_flag(conn, player_id: int, code: str, detail: str, weight: int, now: datetime) -> None:
    inserted = conn.execute(
        """
        INSERT INTO abuse_flags (player_id, code, detail, weight, created_at)
        SELECT %s, %s, %s, %s, %s
        WHERE NOT EXISTS (
            SELECT 1 FROM abuse_flags
            WHERE player_id = %s AND code = %s AND resolved_at IS NULL
        )
        RETURNING id
        """,
        (player_id, code, detail, weight, now, player_id, code),
    ).fetchone()
    if inserted and weight > 0:
        conn.execute(
            "UPDATE players SET abuse_score = abuse_score + %s WHERE id = %s",
            (weight, player_id),
        )


def has_open_flag(conn, player_id: int, code: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM abuse_flags WHERE player_id = %s AND code = %s AND resolved_at IS NULL",
            (player_id, code),
        ).fetchone()
        is not None
    )


def audit(conn, actor: str, action: str, detail: dict, now: datetime) -> None:
    conn.execute(
        "INSERT INTO admin_audit (actor, action, detail, created_at) VALUES (%s, %s, %s, %s)",
        (actor[:120], action, Json(detail), now),
    )


def score_filter(board: str, now: datetime, season) -> tuple[str, list]:
    if board == "daily":
        start, end = utc_day_bounds(now)
        return "AND created_at >= %s AND created_at < %s", [start, end]
    if board == "weekly":
        today = now.date()
        start_day = today - timedelta(days=today.weekday())
        start = datetime(start_day.year, start_day.month, start_day.day, tzinfo=timezone.utc)
        return "AND created_at >= %s AND created_at < %s", [start, start + timedelta(days=7)]
    if board == "season":
        if season is None:
            return "AND FALSE", []
        return "AND season_id = %s", [int(season["id"])]
    if board == "alltime":
        return "", []
    raise GameError("bad_board", "Leaderboard must be daily, weekly, season, or alltime.", 400)


def score_and_rank(conn, player_id: int, extra_sql: str, params: list) -> tuple[int, int]:
    query = f"""
        WITH scores AS (
            SELECT player_id, SUM(amount)::bigint AS score
            FROM point_ledger
            WHERE amount > 0 {extra_sql}
            GROUP BY player_id
        )
        SELECT
            COALESCE((SELECT score FROM scores WHERE player_id = %s), 0) AS score,
            (
                SELECT 1 + COUNT(*)
                FROM scores
                WHERE score > COALESCE((SELECT score FROM scores WHERE player_id = %s), 0)
            ) AS rank
    """
    row = conn.execute(query, (*params, player_id, player_id)).fetchone()
    return int(row["score"]), int(row["rank"])


def public_admin_player(row) -> dict:
    return {
        "id": int(row["id"]),
        "telegramId": int(row["telegram_id"]),
        "username": row["username"],
        "displayName": row["display_name"],
        "referralCode": row["referral_code"],
        "points": int(row["points"]),
        "nodeLevel": int(row["node_level"]),
        "banned": bool(row["banned"]),
        "abuseScore": int(row["abuse_score"]),
        "walletAddress": row["wallet_address"],
        "createdAt": iso(row["created_at"]),
    }


def invite_link(bot_username: str, code: str) -> str:
    if bot_username:
        return f"https://t.me/{bot_username}?start=ref_{code}"
    return f"ref_{code}"


def referral_code_from_param(start: str) -> str | None:
    code = start[4:] if start.startswith("ref_") else start
    if len(code) == 8 and all(ch in ALPHABET for ch in code):
        return code
    return None


def new_referral_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(8))


def require_key(key: str) -> None:
    import re

    if not isinstance(key, str) or not re.fullmatch(KEY_RE_SOURCE, key):
        raise GameError("bad_idempotency_key", "idempotencyKey must be 8–80 safe characters.", 400)


def reject_if_banned(player) -> None:
    if player["banned"]:
        raise GameError("banned", "This node is suspended.", 403)


def iso(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return value.isoformat()

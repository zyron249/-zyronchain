"""Upgrade tree, daily play-points limit, and the free daily chest bonus."""

from datetime import timedelta

import pytest

from tests.test_api import NOW, auth
from zyron_node import economy
from zyron_node.db import apply_migrations
from zyron_node.economy import (
    CHEST_ODDS_TOTAL,
    COSMETICS,
    DAILY_CHEST_OUTCOMES,
    DAILY_PLAY_POINTS_CAP,
    LEVEL_IDS,
    MODULE_ORDER,
    MODULES,
    TREE,
    TREE_ORDER,
    chest_outcome_for,
    cycle_reward,
    empty_levels,
    max_cycles_in_day,
    max_energy,
    node_level,
    regen_interval_seconds,
    tree_cost,
    tree_cost_table,
)

ADMIN = {"Authorization": "Bearer test-admin-token"}


def maxed(include_tree: bool) -> dict:
    levels = empty_levels()
    for module in MODULE_ORDER:
        levels[module] = MODULES[module].max_level
    if include_tree:
        for branch in TREE_ORDER:
            levels[branch] = TREE[branch].max_level
    return levels


def player_row(client, telegram_id):
    with client.app.state.pool.connection() as conn:
        return conn.execute("SELECT * FROM players WHERE telegram_id = %s", (telegram_id,)).fetchone()


def set_points(client, telegram_id, points):
    with client.app.state.pool.connection() as conn:
        with conn.transaction():
            conn.execute("UPDATE players SET points = %s WHERE telegram_id = %s", (points, telegram_id))


def buy(client, telegram_id, branch, key, when=NOW):
    return client.post("/api/tree/upgrade", json={"upgrade": branch, "idempotencyKey": key}, headers=auth(telegram_id, when))


# ---- pure economy -----------------------------------------------------------------------------------------


def test_tree_costs_rise_and_stop_at_a_hard_max():
    table = tree_cost_table()
    assert table == {
        "capacity": [80, 128, 205, 328, 524, 839, 1342, 2147, 3436, 5498],
        "recovery": [120, 198, 327, 539, 889, 1468, 2422, 3995, 6593, 10878],
        "efficiency": [150, 255, 434, 737, 1253, 2130, 3621, 6155, 10464, 17788],
    }
    for branch, costs in table.items():
        assert all(b > a for a, b in zip(costs, costs[1:]))
        with pytest.raises(ValueError):
            tree_cost(branch, TREE[branch].max_level)
        with pytest.raises(ValueError):
            tree_cost(branch, -1)
    assert set(LEVEL_IDS) == set(MODULE_ORDER) | set(TREE_ORDER)


def test_tree_effects_respect_existing_ceilings():
    base = empty_levels()
    one = dict(base, capacity=1, recovery=1, efficiency=1)
    assert max_energy(one) == max_energy(base) + 10
    assert regen_interval_seconds(one) == regen_interval_seconds(base) - 6
    assert cycle_reward(one, 0) == cycle_reward(base, 0) + 1
    full = maxed(include_tree=True)
    assert regen_interval_seconds(full) == 60  # existing floor
    assert max_energy(full) <= 5_000
    assert cycle_reward(full, 99) <= economy.MAX_CYCLE_REWARD
    # The tree never moves node level or level chests.
    assert node_level(dict(base, capacity=10, recovery=10, efficiency=10)) == 1


def test_daily_cap_equals_the_pre_tree_ceiling_and_binds_on_the_tree():
    legacy = maxed(include_tree=False)
    assert max_cycles_in_day(legacy) == 560 + 864
    assert cycle_reward(legacy, 15) == 42
    assert DAILY_PLAY_POINTS_CAP == 1424 * 42 == 59_808
    # Without the cap a fully upgraded tree could issue more than before; the cap holds it to the old ceiling.
    full = maxed(include_tree=True)
    assert max_cycles_in_day(full) * cycle_reward(full, 15) > DAILY_PLAY_POINTS_CAP
    # Even the daily chest bonus fits inside the same limit (it is counted against it).
    assert economy.daily_chest_bonus_max() == 50


def test_chest_odds_are_fixed_and_cover_every_roll():
    assert sum(item.weight for item in DAILY_CHEST_OUTCOMES) == CHEST_ODDS_TOTAL == 1000
    assert [item.weight for item in DAILY_CHEST_OUTCOMES] == [550, 250, 120, 30, 50]
    assert chest_outcome_for(0).id == "p5"
    assert chest_outcome_for(549).id == "p5"
    assert chest_outcome_for(550).id == "p10"
    assert chest_outcome_for(799).id == "p10"
    assert chest_outcome_for(800).id == "p20"
    assert chest_outcome_for(920).id == "p50"
    assert chest_outcome_for(950).id == "cosmetic"
    assert chest_outcome_for(999).id == "cosmetic"
    for bad in (-1, 1000):
        with pytest.raises(ValueError):
            chest_outcome_for(bad)
    counts = {}
    for roll in range(1000):
        counts[chest_outcome_for(roll).id] = counts.get(chest_outcome_for(roll).id, 0) + 1
    assert counts == {item.id: item.weight for item in DAILY_CHEST_OUTCOMES}
    banned = ("price", "invest", "profit", "zyn", "airdrop", "guarantee", "token", "buy")
    for text in [o["label"] for o in economy.chest_odds()] + [c.title + c.detail for c in COSMETICS]:
        assert not any(word in text.lower() for word in banned)


# ---- API ----------------------------------------------------------------------------------------------------


def test_migration_is_idempotent(client):
    with client.app.state.pool.connection() as conn:
        with conn.transaction():
            conn.execute("DELETE FROM schema_migrations WHERE version = '007_upgrade_tree.sql'")
            assert apply_migrations(conn) == ["007_upgrade_tree.sql"]
            assert apply_migrations(conn) == []


def test_tree_purchase_burns_points_and_is_idempotent(client):
    assert client.get("/api/me", headers=auth(701)).status_code == 200
    set_points(client, 701, 300)
    first = buy(client, 701, "capacity", "tree-key-0001")
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["replayed"] is False and body["level"] == 1 and body["spent"] == 80
    # 300 - 80 spent + 10 for the existing "Rack mounted" first-upgrade achievement.
    assert body["achievementsUnlocked"] == ["first_upgrade"]
    assert body["points"] == 230
    assert body["energy"]["max"] == 110
    again = buy(client, 701, "capacity", "tree-key-0001")
    assert again.status_code == 200
    assert again.json()["replayed"] is True
    assert again.json()["points"] == 230
    row = player_row(client, 701)
    assert int(row["points"]) == 230
    assert int(row["lifetime_points"]) == 10  # only the achievement; spending never mints or reduces lifetime
    with client.app.state.pool.connection() as conn:
        spends = conn.execute(
            "SELECT amount FROM point_ledger WHERE player_id = %s AND reason = 'upgrade'", (row["id"],)
        ).fetchall()
    assert [int(r["amount"]) for r in spends] == [-80]
    view = client.get("/api/upgrades", headers=auth(701)).json()
    tree = {item["id"]: item for item in view["tree"]}
    assert tree["capacity"]["level"] == 1 and tree["capacity"]["nextCost"] == 128
    assert tree["capacity"]["stat"] == {"label": "Max energy", "current": 110, "next": 120, "unit": ""}
    assert tree["efficiency"]["costs"][0] == 150
    assert view["nodeLevel"] == 1
    assert view["dailyPoints"]["cap"] == DAILY_PLAY_POINTS_CAP
    assert [o["percent"] for o in view["chest"]["odds"]] == ["55.0", "25.0", "12.0", "3.0", "5.0"]
    assert {c["id"] for c in view["cosmetics"]} == {c.id for c in COSMETICS}


def test_tree_purchase_rejections(client):
    assert client.get("/api/me", headers=auth(702)).status_code == 200
    set_points(client, 702, 100)
    poor = buy(client, 702, "efficiency", "tree-poor-0001")
    assert poor.status_code == 409 and poor.json()["error"]["code"] == "insufficient_points"
    assert int(player_row(client, 702)["points"]) == 100
    assert buy(client, 702, "turbo", "tree-bad-00001").status_code == 400
    assert buy(client, 702, "Capacity!", "tree-bad-00002").status_code == 422
    assert buy(client, 702, "capacity", "short").status_code == 422
    set_points(client, 702, 1_000_000)
    for n in range(10):
        res = buy(client, 702, "recovery", f"tree-max-{n:04d}", NOW + timedelta(seconds=n))
        assert res.status_code == 200, res.text
    assert res.json()["level"] == 10
    capped = buy(client, 702, "recovery", "tree-max-0010", NOW + timedelta(seconds=11))
    assert capped.status_code == 409 and capped.json()["error"]["code"] == "max_level"
    assert int(player_row(client, 702)["points"]) == 1_000_000 - sum(tree_cost_table()["recovery"]) + 10  # first-upgrade achievement
    me = client.get("/api/me", headers=auth(702, NOW + timedelta(seconds=12))).json()
    assert me["player"]["energy"]["regenSeconds"] == 240


def test_tree_purchases_are_rate_limited_per_account(client):
    assert client.get("/api/me", headers=auth(703)).status_code == 200
    set_points(client, 703, 0)
    codes = [buy(client, 703, "capacity", f"tree-rate-{n:04d}").status_code for n in range(21)]
    assert codes[:20] == [409] * 20  # not enough points, but each call counts
    assert codes[20] == 429
    # Another account is not affected.
    assert client.get("/api/me", headers=auth(704)).status_code == 200
    assert buy(client, 704, "capacity", "tree-rate-other").status_code == 409


def test_daily_play_cap_clamps_and_blocks_cycles_until_utc_midnight(client):
    assert client.get("/api/me", headers=auth(705)).status_code == 200
    with client.app.state.pool.connection() as conn:
        with conn.transaction():
            conn.execute(
                "UPDATE players SET play_points_day = %s, play_points_today = %s WHERE telegram_id = 705",
                (NOW.date(), DAILY_PLAY_POINTS_CAP - 1),
            )
    with client.app.state.pool.connection() as conn:
        with conn.transaction():
            pid = player_row(client, 705)["id"]
            conn.execute("UPDATE player_upgrades SET level = 10 WHERE player_id = %s AND module = 'cpu'", (pid,))
    first = client.post("/api/cycle", json={"idempotencyKey": "cap-cycle-0001"}, headers=auth(705, NOW + timedelta(seconds=2)))
    assert first.status_code == 200, first.text
    assert first.json()["gained"] == 1  # clamped to what is left today
    assert first.json()["dailyPoints"]["remaining"] == 0
    blocked = client.post("/api/cycle", json={"idempotencyKey": "cap-cycle-0002"}, headers=auth(705, NOW + timedelta(seconds=4)))
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "daily_cap"
    assert "off-chain" in blocked.json()["error"]["message"]
    tomorrow = NOW.replace(hour=0, minute=0, second=5) + timedelta(days=1)
    fresh = client.post("/api/cycle", json={"idempotencyKey": "cap-cycle-0003"}, headers=auth(705, tomorrow))
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["gained"] == 11
    assert fresh.json()["dailyPoints"]["used"] == 11


def test_daily_chest_bonus_rolls_once_and_cosmetics_never_repeat(client, fixed_chest_roll, monkeypatch):
    monkeypatch.setattr(fixed_chest_roll, "_chest_roll", lambda: 999)  # cosmetic slot
    owned = []
    for day in range(len(COSMETICS) + 1):
        when = NOW + timedelta(days=day)
        res = client.post("/api/chests/open", json={"id": "daily"}, headers=auth(706, when))
        assert res.status_code == 200, res.text
        bonus = res.json()["bonus"]
        if day < len(COSMETICS):
            assert bonus["outcome"] == "cosmetic" and bonus["points"] == 0
            owned.append(bonus["cosmetic"]["id"])
        else:
            assert bonus["duplicate"] is True and bonus["cosmetic"] is None
            assert bonus["points"] == economy.COSMETIC_DUPLICATE_POINTS
        replay = client.post("/api/chests/open", json={"id": "daily"}, headers=auth(706, when + timedelta(hours=1)))
        assert replay.json()["replayed"] is True and replay.json()["gained"] == 0
    assert sorted(owned) == sorted(c.id for c in COSMETICS)
    me = client.get("/api/me", headers=auth(706, NOW + timedelta(days=3))).json()
    assert me["player"]["cosmetics"] == sorted(owned)
    with client.app.state.pool.connection() as conn:
        rolls = conn.execute(
            "SELECT COUNT(*) AS n FROM daily_chest_rolls WHERE player_id = %s", (me["player"]["id"],)
        ).fetchone()["n"]
    assert rolls == len(COSMETICS) + 1


def test_streak_claim_route_also_rolls_and_bonus_respects_the_daily_cap(client, fixed_chest_roll, monkeypatch):
    monkeypatch.setattr(fixed_chest_roll, "_chest_roll", lambda: 930)  # +50 slot
    assert client.get("/api/me", headers=auth(707)).status_code == 200
    with client.app.state.pool.connection() as conn:
        with conn.transaction():
            conn.execute(
                "UPDATE players SET play_points_day = %s, play_points_today = %s WHERE telegram_id = 707",
                (NOW.date(), DAILY_PLAY_POINTS_CAP - 7),
            )
    res = client.post("/api/streak/claim", headers=auth(707))
    assert res.status_code == 200, res.text
    assert res.json()["gained"] == 10  # streak is unchanged
    assert res.json()["bonus"]["outcome"] == "p50"
    assert res.json()["bonus"]["points"] == 7  # clamped to the remaining daily limit
    view = client.get("/api/upgrades", headers=auth(707)).json()
    assert view["chest"]["openedToday"] is True
    assert view["chest"]["today"]["points"] == 7
    assert view["dailyPoints"]["remaining"] == 0
    opened = client.post("/api/chests/open", json={"id": "daily"}, headers=auth(707))
    assert opened.json()["replayed"] is True and opened.json()["gained"] == 0


def test_team_accounts_can_upgrade_and_open_but_stay_off_boards(client):
    assert client.get("/api/me", headers=auth(708)).status_code == 200
    pid = player_row(client, 708)["id"]
    assert client.post(f"/api/admin/players/{pid}/team", json={"team": True}, headers={**ADMIN, "X-Test-Now": NOW.isoformat()}).status_code == 200
    assert client.get("/api/me", headers=auth(709)).status_code == 200
    assert client.post("/api/cycle", json={"idempotencyKey": "team-other-0001"}, headers=auth(709, NOW + timedelta(seconds=2))).status_code == 200
    assert client.post("/api/chests/open", json={"id": "daily"}, headers=auth(708)).status_code == 200
    set_points(client, 708, 500)
    assert buy(client, 708, "efficiency", "team-tree-0001").status_code == 200
    board = client.get("/api/leaderboard?board=daily", headers=auth(709, NOW + timedelta(seconds=5))).json()
    assert pid not in [entry["playerId"] for entry in board["entries"]]
    mine = client.get("/api/leaderboard?board=daily", headers=auth(708, NOW + timedelta(seconds=5))).json()
    assert mine["me"]["rank"] is None

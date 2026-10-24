"""Personal block galaxy and an opt-in country map.

The galaxy is drawn from the player's own block count. The world map stores a
country code only when the player picks one. It never reads GPS or an IP.
"""

from __future__ import annotations

from datetime import datetime

# Schematic positions on a 100x100 board. These are catalog dots, not a player's location.
PLACES = (
    ("US", "United States", 20, 40),
    ("CA", "Canada", 18, 30),
    ("MX", "Mexico", 18, 48),
    ("BR", "Brazil", 32, 68),
    ("AR", "Argentina", 30, 82),
    ("GB", "United Kingdom", 48, 32),
    ("IE", "Ireland", 45, 32),
    ("FR", "France", 49, 38),
    ("DE", "Germany", 52, 34),
    ("ES", "Spain", 47, 42),
    ("IT", "Italy", 53, 42),
    ("PL", "Poland", 55, 32),
    ("UA", "Ukraine", 58, 34),
    ("TR", "Turkey", 60, 42),
    ("NG", "Nigeria", 50, 56),
    ("ZA", "South Africa", 56, 78),
    ("EG", "Egypt", 58, 48),
    ("KE", "Kenya", 60, 60),
    ("AE", "United Arab Emirates", 64, 48),
    ("IN", "India", 70, 50),
    ("PK", "Pakistan", 67, 44),
    ("ID", "Indonesia", 80, 64),
    ("TH", "Thailand", 76, 52),
    ("VN", "Vietnam", 78, 52),
    ("PH", "Philippines", 82, 54),
    ("JP", "Japan", 86, 40),
    ("KR", "South Korea", 84, 40),
    ("CN", "China", 76, 40),
    ("AU", "Australia", 84, 76),
    ("NZ", "New Zealand", 92, 82),
)

BY_CODE = {code: (name, x, y) for code, name, x, y in PLACES}


def choices() -> list[dict]:
    return [{"code": code, "name": name} for code, name, _x, _y in PLACES]


def galaxy_for(player_id: int, blocks: int) -> dict:
    shown = max(0, min(48, int(blocks)))
    return {
        "blocks": int(blocks),
        "shown": shown,
        "seed": int(player_id) % 997,
        "notice": "Your completed blocks, drawn as light. No location is used.",
    }


def world_rows(conn) -> list[dict]:
    rows = conn.execute(
        """
        SELECT country_code, COUNT(*)::int AS builders
        FROM players
        WHERE country_code IS NOT NULL AND banned = FALSE AND team_account = FALSE
        GROUP BY country_code
        ORDER BY builders DESC, country_code ASC
        """
    ).fetchall()
    dots = []
    for row in rows:
        code = row["country_code"]
        place = BY_CODE.get(code)
        if place is None:
            continue
        name, x, y = place
        dots.append({"code": code, "name": name, "builders": int(row["builders"]), "x": x, "y": y})
    return dots


def map_view(conn, player) -> dict:
    code = player.get("country_code")
    return {
        "galaxy": galaxy_for(int(player["id"]), int(player["cycle_count"])),
        "country": code,
        "choices": choices(),
        "world": world_rows(conn),
        "notice": "Country only, and only if you opt in. Counts are totals. No precise location.",
    }


def set_country(pool, player_id: int, country: str, key: str, now: datetime) -> dict:
    from zyron_node.game import (
        GameError,
        lock_player,
        reject_if_banned,
        reload_player,
        replay_of,
        require_key,
        store_idempotency,
    )

    require_key(key)
    raw = "".join((country or "").split()).upper()
    if raw and raw not in BY_CODE:
        raise GameError("unknown_country", "Choose a country from the list.", 400)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "country", key)
            if replay:
                return replay
            reject_if_banned(player)
            conn.execute(
                "UPDATE players SET country_code = %s WHERE id = %s",
                (raw or None, player_id),
            )
            player = reload_player(conn, player_id)
            response = {
                "replayed": False,
                "country": player.get("country_code"),
                "map": map_view(conn, player),
                "serverTime": now.isoformat(),
            }
            store_idempotency(conn, player_id, "country", key, response, now)
            return response

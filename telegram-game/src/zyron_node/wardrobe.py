"""Cosmetic builder wardrobe. Unlocks spend Zyron Points and change no gameplay stats."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Wearable:
    id: str
    slot: str
    value: str
    title: str
    detail: str
    cost: int


WEARABLES: tuple[Wearable, ...] = (
    Wearable("helmet_lamp", "helmet", "lamp", "Wide lamp", "A broader helmet lamp. Cosmetic only.", 30),
    Wearable("helmet_crest", "helmet", "crest", "Crest helmet", "A chrome crest on the helmet. Cosmetic only.", 40),
    Wearable("pick_blue", "pickaxe", "blue", "Blue pickaxe", "An electric-blue pickaxe head. Cosmetic only.", 35),
    Wearable("pick_gold", "pickaxe", "gold", "Gold pickaxe", "A gold-colored pickaxe head. Cosmetic only, not a payout.", 80),
    Wearable("color_ice", "color", "ice", "Ice color", "Cooler lamp light. Cosmetic only.", 25),
    Wearable("color_chrome", "color", "chrome", "Chrome color", "A brighter chrome suit. Cosmetic only.", 25),
    Wearable("color_void", "color", "void", "Void color", "A darker suit. Cosmetic only.", 25),
    Wearable("wolf_mask", "mask", "wolf", "Wolf mask", "A wolf mask for your builders. Cosmetic only.", 120),
)
BY_ID = {item.id: item for item in WEARABLES}
FREE = {"helmet": "stock", "pickaxe": "stock", "color": "electric"}


def _owned(conn, player_id: int) -> set[str]:
    rows = conn.execute(
        "SELECT cosmetic_id FROM player_cosmetics WHERE player_id = %s",
        (player_id,),
    ).fetchall()
    return {row["cosmetic_id"] for row in rows}


def _loadout_row(conn, player_id: int):
    return conn.execute("SELECT * FROM player_loadout WHERE player_id = %s", (player_id,)).fetchone()


def loadout_view(row, owned: set[str]) -> dict:
    if row is None:
        helmet, pickaxe, color, mask = "stock", "stock", "electric", False
    else:
        helmet, pickaxe, color, mask = row["helmet"], row["pickaxe"], row["color"], bool(row["wolf_mask"])
    return {"helmet": helmet, "pickaxe": pickaxe, "color": color, "wolfMask": mask and "wolf_mask" in owned}


def wardrobe_view(conn, player_id: int) -> dict:
    owned = _owned(conn, player_id)
    row = _loadout_row(conn, player_id)
    items = []
    for item in WEARABLES:
        items.append(
            {
                "id": item.id,
                "slot": item.slot,
                "value": item.value,
                "title": item.title,
                "detail": item.detail,
                "cost": item.cost,
                "owned": item.id in owned,
            }
        )
    return {"items": items, "loadout": loadout_view(row, owned), "notice": "Cosmetic only. No gameplay bonus."}


def _value_owned(slot: str, value: str, owned: set[str]) -> bool:
    if slot in FREE and value == FREE[slot]:
        return True
    return any(item.slot == slot and item.value == value and item.id in owned for item in WEARABLES)


def unlock(pool, player_id: int, item_id: str, key: str, now: datetime) -> dict:
    from zyron_node.game import (
        GameError,
        apply_points,
        iso,
        lock_player,
        reject_if_banned,
        reload_player,
        replay_of,
        require_key,
        store_idempotency,
    )

    require_key(key)
    item = BY_ID.get(item_id)
    if item is None:
        raise GameError("bad_item", "Unknown cosmetic.", 400)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "wardrobe", key)
            if replay:
                return replay
            reject_if_banned(player)
            owned = _owned(conn, player_id)
            if item.id in owned:
                response = {
                    "replayed": False,
                    "alreadyOwned": True,
                    "spent": 0,
                    "item": item.id,
                    "points": int(player["points"]),
                    "wardrobe": wardrobe_view(conn, player_id),
                    "serverTime": iso(now),
                }
                store_idempotency(conn, player_id, "wardrobe", key, response, now)
                return response
            season = conn.execute(
                "SELECT id FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1"
            ).fetchone()
            paid = apply_points(
                conn,
                player_id,
                -item.cost,
                "wardrobe",
                f"wardrobe:{player_id}:{item.id}",
                int(season["id"]) if season else None,
                now,
            )
            conn.execute(
                """
                INSERT INTO player_cosmetics (player_id, cosmetic_id, source, acquired_at)
                VALUES (%s, %s, 'points', %s)
                ON CONFLICT DO NOTHING
                """,
                (player_id, item.id, now),
            )
            player = reload_player(conn, player_id)
            response = {
                "replayed": False,
                "alreadyOwned": not paid,
                "spent": item.cost if paid else 0,
                "item": item.id,
                "points": int(player["points"]),
                "wardrobe": wardrobe_view(conn, player_id),
                "serverTime": iso(now),
            }
            store_idempotency(conn, player_id, "wardrobe", key, response, now)
            return response


def equip(pool, player_id: int, key: str, helmet: str, pickaxe: str, color: str, wolf_mask: bool, now: datetime) -> dict:
    from zyron_node.game import (
        GameError,
        iso,
        lock_player,
        reject_if_banned,
        replay_of,
        require_key,
        store_idempotency,
    )

    require_key(key)
    with pool.connection() as conn:
        with conn.transaction():
            player = lock_player(conn, player_id)
            replay = replay_of(conn, player_id, "equip", key)
            if replay:
                return replay
            reject_if_banned(player)
            owned = _owned(conn, player_id)
            choices = {"helmet": helmet, "pickaxe": pickaxe, "color": color}
            for slot, value in choices.items():
                if not _value_owned(slot, value, owned):
                    raise GameError("locked_cosmetic", "That cosmetic is still locked.", 409)
            if wolf_mask and "wolf_mask" not in owned:
                raise GameError("locked_cosmetic", "The wolf mask is still locked.", 409)
            conn.execute(
                """
                INSERT INTO player_loadout (player_id, helmet, pickaxe, color, wolf_mask, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (player_id) DO UPDATE
                SET helmet = EXCLUDED.helmet,
                    pickaxe = EXCLUDED.pickaxe,
                    color = EXCLUDED.color,
                    wolf_mask = EXCLUDED.wolf_mask,
                    updated_at = EXCLUDED.updated_at
                """,
                (player_id, helmet, pickaxe, color, wolf_mask, now),
            )
            response = {
                "replayed": False,
                "loadout": loadout_view(_loadout_row(conn, player_id), owned),
                "serverTime": iso(now),
            }
            store_idempotency(conn, player_id, "equip", key, response, now)
            return response

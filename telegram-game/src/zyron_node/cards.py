"""Share cards. The server decides who earned one and the exact public line.

Sharing does not pay points. A locked card is refused.
"""

from __future__ import annotations

from zyron_node.economy import node_level
from zyron_node.game import GameError, load_levels

FOOTER = "Zyron Points stay off-chain and separate from ZYN."


def _captain(conn, player_id: int) -> bool:
    row = conn.execute(
        "SELECT role FROM squad_members WHERE player_id = %s",
        (player_id,),
    ).fetchone()
    return bool(row and row["role"] == "captain")


def _facts(conn, player) -> dict:
    return {
        "streak": int(player["longest_streak"]),
        "blocks": int(player["cycle_count"]),
        "level": node_level(load_levels(conn, int(player["id"]))),
        "captain": _captain(conn, int(player["id"])),
    }


def _catalog(facts: dict) -> list[dict]:
    return [
        {
            "id": "streak_7",
            "title": "7-day streak",
            "detail": "Seven days in a row on the node.",
            "earned": facts["streak"] >= 7,
        },
        {
            "id": "gold_node",
            "title": "Gold node reached",
            "detail": "The node reached gold.",
            "earned": facts["level"] >= 6,
        },
        {
            "id": "blocks_100",
            "title": "First 100 blocks",
            "detail": "One hundred blocks completed.",
            "earned": facts["blocks"] >= 100,
        },
        {
            "id": "team_captain",
            "title": "Team captain",
            "detail": "Captain of a builder squad.",
            "earned": facts["captain"],
        },
    ]


def _public(card: dict) -> dict:
    payload = {
        "id": card["id"],
        "title": card["title"],
        "detail": card["detail"],
        "earned": card["earned"],
        "footer": FOOTER,
    }
    if card["earned"]:
        payload["line"] = card["title"] + " on ZYRON NODE. " + FOOTER
    return payload


def cards_view(conn, player) -> dict:
    facts = _facts(conn, player)
    return {"cards": [_public(card) for card in _catalog(facts)]}


def card_view(conn, player, card_id: str) -> dict:
    facts = _facts(conn, player)
    for card in _catalog(facts):
        if card["id"] == card_id:
            if not card["earned"]:
                raise GameError("card_locked", "That card is not earned yet.", 403)
            return _public(card)
    raise GameError("not_found", "Unknown card.", 404)

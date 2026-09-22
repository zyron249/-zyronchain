"""Quest and achievement definitions. Completion is computed on the server."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime


@dataclass(frozen=True)
class Quest:
    id: str
    title: str
    description: str
    period: str
    target: int
    reward: int
    metric: str


@dataclass(frozen=True)
class Achievement:
    id: str
    title: str
    description: str
    reward: int
    metric: str
    target: int


QUESTS: tuple[Quest, ...] = (
    Quest("daily_login", "Daily check-in", "Claim today's login streak.", "daily", 1, 15, "streak_claimed_today"),
    Quest("daily_cycles", "Cycle the node", "Run 25 fictional node cycles today.", "daily", 25, 40, "cycles_today"),
    Quest(
        "daily_chain",
        "Observe the chain",
        "The server completes a read-only Zyron RPC status read.",
        "daily",
        1,
        10,
        "chain_status_today",
    ),
    Quest("once_upgrade", "Install hardware", "Upgrade any node module once.", "once", 1, 25, "upgrade_total"),
    Quest(
        "once_wallet",
        "Link a watch address",
        "Save a read-only ZYN address. No key is requested or stored.",
        "once",
        1,
        30,
        "wallet_linked",
    ),
    Quest(
        "once_chain_wallet",
        "Address on the observer",
        "The server reads your linked address from the configured Zyron RPC.",
        "once",
        1,
        20,
        "chain_wallet_once",
    ),
    Quest("once_referral", "Grow the mesh", "One invited operator qualifies.", "once", 1, 50, "qualified_referrals"),
    Quest("weekly_power", "Raise network power", "Reach 80 Network Power.", "weekly", 80, 35, "network_power"),
)

ACHIEVEMENTS: tuple[Achievement, ...] = (
    Achievement("first_cycle", "Online", "Run your first node cycle.", 5, "cycle_count", 1),
    Achievement("cycles_100", "Steady operator", "Run 100 node cycles.", 25, "cycle_count", 100),
    Achievement("cycles_1000", "Night shift", "Run 1,000 node cycles.", 100, "cycle_count", 1000),
    Achievement("first_upgrade", "Rack mounted", "Purchase any upgrade.", 10, "upgrade_total", 1),
    Achievement("streak_3", "Three-day link", "Reach a 3-day login streak.", 15, "longest_streak", 3),
    Achievement("streak_7", "Week on watch", "Reach a 7-day login streak.", 40, "longest_streak", 7),
    Achievement("streak_30", "Month on watch", "Reach a 30-day login streak.", 150, "longest_streak", 30),
    Achievement("power_80", "Mesh node", "Reach 80 Network Power.", 20, "network_power", 80),
    Achievement("power_250", "Regional node", "Reach 250 Network Power.", 60, "network_power", 250),
    Achievement("wallet", "Watch address", "Link a read-only wallet address.", 10, "wallet_linked", 1),
    Achievement("referral", "Signal booster", "Qualify one referral.", 30, "qualified_referrals", 1),
    Achievement("referral_5", "Community relay", "Qualify five referrals.", 80, "qualified_referrals", 5),
)

QUESTS_BY_ID = {quest.id: quest for quest in QUESTS}
ACHIEVEMENTS_BY_ID = {item.id: item for item in ACHIEVEMENTS}


def period_key(period: str, today: date) -> str:
    if period == "daily":
        return today.isoformat()
    if period == "weekly":
        iso = today.isocalendar()
        return f"{iso.year}-W{iso.week:02d}"
    if period == "once":
        return "once"
    raise ValueError(f"unknown period {period}")


def utc_day_bounds(now: datetime) -> tuple[datetime, datetime]:
    from datetime import timedelta, timezone

    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    return start, start + timedelta(days=1)

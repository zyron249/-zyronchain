"""Authoritative gameplay formulas. Clients may display these numbers; they cannot set them."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP

POINTS_NOTICE = (
    "Zyron Points are off-chain gameplay points. "
    "There is no conversion rate to ZYN or Zyrum. "
    "Node cycles are fictional and are not ZyronChain mining."
)

MAX_CYCLE_REWARD = 250
REFERRER_REWARD = 100
REFEREE_REWARD = 25
REFERRAL_WEEKLY_CAP = 20
ABUSE_REFERRAL_BLOCK = 80

# Index 0 is unused. Days 1–30 are explicit; later days keep the day-30 reward.
STREAK_REWARDS: tuple[int, ...] = (
    0,
    10, 15, 20, 30, 45, 70, 120,
    20, 25, 30, 40, 55, 80, 140,
    25, 30, 40, 50, 65, 95, 160,
    30, 40, 50, 65, 85, 110, 180,
    200, 280,
)
assert len(STREAK_REWARDS) == 31


@dataclass(frozen=True)
class ModuleSpec:
    id: str
    title: str
    summary: str
    base_cost: int
    growth: str
    max_level: int


MODULES: dict[str, ModuleSpec] = {
    "cpu": ModuleSpec("cpu", "CPU", "Increases Zyron Points earned each node cycle.", 20, "1.45", 20),
    "network": ModuleSpec("network", "Network", "Raises Network Power.", 30, "1.48", 20),
    "storage": ModuleSpec("storage", "Storage", "Improves quest payouts and energy capacity.", 25, "1.46", 20),
    "validator": ModuleSpec(
        "validator",
        "Validator Power",
        "Heavy cycle output and Network Power. Gameplay only — this does not join the ZyronChain validator set.",
        60,
        "1.55",
        15,
    ),
    "security": ModuleSpec(
        "security",
        "Security",
        "Adds Network Power and a little energy capacity. It does not bypass anti-cheat or bans.",
        28,
        "1.47",
        20,
    ),
    "energy": ModuleSpec("energy", "Energy Core", "Raises the energy cap and regeneration speed.", 35, "1.50", 20),
    "reputation": ModuleSpec("reputation", "Reputation", "Improves cycle yield.", 40, "1.52", 15),
}

MODULE_ORDER: tuple[str, ...] = ("cpu", "network", "storage", "validator", "security", "energy", "reputation")


def empty_levels() -> dict[str, int]:
    return {module: 0 for module in MODULE_ORDER}


def normalize_levels(raw: dict[str, int] | None) -> dict[str, int]:
    levels = empty_levels()
    if not raw:
        return levels
    for module in MODULE_ORDER:
        value = int(raw.get(module, 0))
        spec = MODULES[module]
        if value < 0 or value > spec.max_level:
            raise ValueError(f"invalid level for {module}")
        levels[module] = value
    return levels


def upgrade_cost(module: str, current_level: int) -> int:
    spec = MODULES[module]
    if current_level < 0 or current_level >= spec.max_level:
        raise ValueError("module is at maximum level")
    value = Decimal(spec.base_cost) * (Decimal(spec.growth) ** current_level)
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def cycle_reward(levels: dict[str, int], streak_count: int) -> int:
    levels = normalize_levels(levels)
    base = 1 + levels["cpu"] + (levels["validator"] // 2)
    streak_days = min(max(int(streak_count), 0), 15)
    bps = 10_000 + streak_days * 200 + levels["reputation"] * 150
    reward = (base * bps) // 10_000
    return max(1, min(MAX_CYCLE_REWARD, reward))


def network_power(levels: dict[str, int]) -> int:
    levels = normalize_levels(levels)
    return (
        10
        + levels["cpu"] * 2
        + levels["network"] * 8
        + levels["storage"] * 3
        + levels["validator"] * 12
        + levels["security"] * 4
        + levels["energy"]
        + levels["reputation"] * 5
    )


def node_level(levels: dict[str, int]) -> int:
    levels = normalize_levels(levels)
    return 1 + (sum(levels.values()) // 4)


def max_energy(levels: dict[str, int]) -> int:
    levels = normalize_levels(levels)
    return min(5_000, 100 + levels["energy"] * 20 + levels["storage"] * 2 + levels["security"])


def regen_interval_seconds(levels: dict[str, int]) -> int:
    levels = normalize_levels(levels)
    return max(60, 300 - levels["energy"] * 10)


def apply_energy(
    current: int,
    updated_at: datetime,
    now: datetime,
    levels: dict[str, int],
) -> tuple[int, datetime]:
    """Regenerate energy from server timestamps. Time already at the cap is not banked."""
    levels = normalize_levels(levels)
    cap = max_energy(levels)
    current = max(0, min(int(current), cap))
    if current >= cap:
        return cap, now
    elapsed = (now - updated_at).total_seconds()
    if elapsed <= 0:
        return current, updated_at
    interval = regen_interval_seconds(levels)
    gained = int(elapsed // interval)
    if gained <= 0:
        return current, updated_at
    regenerated = min(cap, current + gained)
    if regenerated >= cap:
        return cap, now
    return regenerated, updated_at + timedelta(seconds=gained * interval)


def seconds_until_next_energy(current: int, updated_at: datetime, now: datetime, levels: dict[str, int]) -> int:
    levels = normalize_levels(levels)
    if current >= max_energy(levels):
        return 0
    elapsed = (now - updated_at).total_seconds()
    if elapsed < 0:
        return regen_interval_seconds(levels)
    interval = regen_interval_seconds(levels)
    remain = interval - (elapsed % interval)
    if remain <= 0:
        return interval
    return int(remain)


def streak_reward(day: int) -> int:
    if day < 1:
        raise ValueError("streak day must be positive")
    return STREAK_REWARDS[min(day, 30)]


def advance_streak(last: date | None, count: int, today: date) -> tuple[int, bool]:
    """Return (streak after this claim, whether a new claim should be paid)."""
    if last == today:
        return count, False
    if last is not None and last == today - timedelta(days=1):
        return count + 1, True
    return 1, True


def quest_payout(base_reward: int, storage_level: int) -> int:
    if base_reward < 0 or storage_level < 0:
        raise ValueError("invalid quest payout")
    return base_reward + storage_level

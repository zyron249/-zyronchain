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
# One-time level supply chest pays this times (level - 1). Not ZYN.
LEVEL_CHEST_STEP = 10

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

# Upgrade tree (Upgrades tab). Same player_upgrades table, separate ids, never counted toward node level.
# Spending burns Zyron Points. Effects are bounded by MAX_CYCLE_REWARD, the 60 s regen floor, the 5,000 energy
# ceiling and DAILY_PLAY_POINTS_CAP, so the tree cannot raise daily issuance above the pre-tree ceiling.
TREE_CAPACITY_STEP = 10  # +energy cap per level
TREE_RECOVERY_STEP = 6  # seconds shaved off each energy point per level
TREE_EFFICIENCY_STEP = 1  # +base points per cycle per level (before streak/Reputation multipliers)


@dataclass(frozen=True)
class TreeSpec:
    id: str
    title: str
    summary: str
    effect: str
    base_cost: int
    growth: str
    max_level: int


TREE: dict[str, TreeSpec] = {
    "capacity": TreeSpec(
        "capacity",
        "Energy capacity",
        "A bigger energy cell, so the node runs longer between refills.",
        f"+{TREE_CAPACITY_STEP} max energy per level",
        80,
        "1.60",
        10,
    ),
    "recovery": TreeSpec(
        "recovery",
        "Recovery speed",
        "Energy comes back faster. Regen never drops below 60 s per point.",
        f"-{TREE_RECOVERY_STEP} s per energy point per level",
        120,
        "1.65",
        10,
    ),
    "efficiency": TreeSpec(
        "efficiency",
        "Builder efficiency",
        "Builders carve more per cycle. Still capped at 250 per cycle and by the daily limit.",
        f"+{TREE_EFFICIENCY_STEP} base off-chain point per cycle per level",
        150,
        "1.70",
        10,
    ),
}

TREE_ORDER: tuple[str, ...] = ("capacity", "recovery", "efficiency")
LEVEL_IDS: tuple[str, ...] = MODULE_ORDER + TREE_ORDER


def _spec_max(level_id: str) -> int:
    if level_id in MODULES:
        return MODULES[level_id].max_level
    return TREE[level_id].max_level


def empty_levels() -> dict[str, int]:
    return {level_id: 0 for level_id in LEVEL_IDS}


def normalize_levels(raw: dict[str, int] | None) -> dict[str, int]:
    levels = empty_levels()
    if not raw:
        return levels
    for level_id in LEVEL_IDS:
        value = int(raw.get(level_id, 0))
        if value < 0 or value > _spec_max(level_id):
            raise ValueError(f"invalid level for {level_id}")
        levels[level_id] = value
    return levels


def _rounded_cost(base_cost: int, growth: str, current_level: int) -> int:
    value = Decimal(base_cost) * (Decimal(growth) ** current_level)
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def upgrade_cost(module: str, current_level: int) -> int:
    spec = MODULES[module]
    if current_level < 0 or current_level >= spec.max_level:
        raise ValueError("module is at maximum level")
    return _rounded_cost(spec.base_cost, spec.growth, current_level)


def tree_cost(branch: str, current_level: int) -> int:
    spec = TREE[branch]
    if current_level < 0 or current_level >= spec.max_level:
        raise ValueError("upgrade is at maximum level")
    return _rounded_cost(spec.base_cost, spec.growth, current_level)


def tree_cost_table() -> dict[str, list[int]]:
    return {branch: [tree_cost(branch, n) for n in range(TREE[branch].max_level)] for branch in TREE_ORDER}


def cycle_reward(levels: dict[str, int], streak_count: int) -> int:
    levels = normalize_levels(levels)
    base = 1 + levels["cpu"] + (levels["validator"] // 2) + levels["efficiency"] * TREE_EFFICIENCY_STEP
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


def module_total(levels: dict[str, int]) -> int:
    """Node-module levels only. The upgrade tree does not raise node level or level chests."""
    levels = normalize_levels(levels)
    return sum(levels[module] for module in MODULE_ORDER)


def node_level(levels: dict[str, int]) -> int:
    return 1 + (module_total(levels) // 4)


MAX_ENERGY_CEILING = 5_000
REGEN_FLOOR_SECONDS = 60


def max_energy(levels: dict[str, int]) -> int:
    levels = normalize_levels(levels)
    return min(
        MAX_ENERGY_CEILING,
        100
        + levels["energy"] * 20
        + levels["storage"] * 2
        + levels["security"]
        + levels["capacity"] * TREE_CAPACITY_STEP,
    )


def regen_interval_seconds(levels: dict[str, int]) -> int:
    levels = normalize_levels(levels)
    return max(REGEN_FLOOR_SECONDS, 300 - levels["energy"] * 10 - levels["recovery"] * TREE_RECOVERY_STEP)


def max_cycles_in_day(levels: dict[str, int]) -> int:
    """Upper bound on accepted cycles in one UTC day: a full cell at 00:00 plus every regen tick that day."""
    return max_energy(levels) + 86_400 // regen_interval_seconds(levels)


def _legacy_daily_ceiling() -> int:
    """Most cycle points one operator could earn in a UTC day before the upgrade tree existed.

    Every node module maxed, 15+ day streak (the multiplier stops there), no tree levels.
    """
    maxed = empty_levels()
    for module in MODULE_ORDER:
        maxed[module] = MODULES[module].max_level
    return max_cycles_in_day(maxed) * cycle_reward(maxed, 15)


# Hard per-operator, per-UTC-day limit on gameplay issuance (node cycles + daily chest bonus). It equals the
# pre-tree ceiling (1,424 cycles x 42 points = 59,808), so upgrades and the chest bonus cannot push daily
# issuance above what was already possible. Streak, quest, level and referral rewards are unchanged and
# keep their own fixed amounts and caps.
DAILY_PLAY_POINTS_CAP = _legacy_daily_ceiling()


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


def level_chest_reward(level: int) -> int:
    """Deterministic supply chest for reaching a node level. Paid once. Not ZYN."""
    if level < 2 or level > 99:
        raise ValueError("level chest is out of range")
    return LEVEL_CHEST_STEP * (level - 1)


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


# Free daily chest bonus. Rolled once per operator per UTC day when the daily supply chest (the streak claim) is
# opened, stored in daily_chest_rolls so it can never be re-rolled. Odds are fixed here and shown in the UI.
# Weights are out of 1,000. No paid chests exist.
@dataclass(frozen=True)
class ChestOutcome:
    id: str
    label: str
    weight: int
    points: int
    cosmetic: bool = False


DAILY_CHEST_OUTCOMES: tuple[ChestOutcome, ...] = (
    ChestOutcome("p5", "+5 off-chain points", 550, 5),
    ChestOutcome("p10", "+10 off-chain points", 250, 10),
    ChestOutcome("p20", "+20 off-chain points", 120, 20),
    ChestOutcome("p50", "+50 off-chain points", 30, 50),
    ChestOutcome("cosmetic", "Builder cosmetic", 50, 0, True),
)
CHEST_ODDS_TOTAL = 1_000
assert sum(item.weight for item in DAILY_CHEST_OUTCOMES) == CHEST_ODDS_TOTAL
# A cosmetic roll when every cosmetic is already owned pays this instead (shown in the UI).
COSMETIC_DUPLICATE_POINTS = 50


@dataclass(frozen=True)
class Cosmetic:
    id: str
    title: str
    detail: str


COSMETICS: tuple[Cosmetic, ...] = (
    Cosmetic("bright_lamps", "Bright head lamps", "Your builders' helmet lamps glow brighter."),
    Cosmetic("blue_picks", "Blue pickaxes", "Electric-blue pickaxe heads for your builders."),
    Cosmetic("wolf_badge", "Wolf operator badge", "A chrome wolf badge on your points card."),
)
COSMETICS_BY_ID = {item.id: item for item in COSMETICS}


def chest_outcome_for(roll: int) -> ChestOutcome:
    """Map a uniform roll in [0, 1000) to an outcome by cumulative weight."""
    if roll < 0 or roll >= CHEST_ODDS_TOTAL:
        raise ValueError("roll out of range")
    edge = 0
    for item in DAILY_CHEST_OUTCOMES:
        edge += item.weight
        if roll < edge:
            return item
    raise AssertionError("unreachable")


def chest_odds() -> list[dict]:
    return [
        {
            "id": item.id,
            "label": item.label,
            "percent": f"{item.weight / 10:.1f}",
            "points": item.points,
            "cosmetic": item.cosmetic,
        }
        for item in DAILY_CHEST_OUTCOMES
    ]


def daily_chest_bonus_max() -> int:
    return max(max(item.points for item in DAILY_CHEST_OUTCOMES), COSMETIC_DUPLICATE_POINTS)

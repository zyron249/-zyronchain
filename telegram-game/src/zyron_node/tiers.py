"""Competitive tiers from lifetime Zyron Points.

Tiers do not reset daily, weekly, or by season. The primary metric is
``players.lifetime_points``: the denormalized sum of positive earnings.
Spending points on upgrades does not reduce it. The activity ledger is the
audit source; this module only turns a lifetime total into a tier.

Thresholds follow the live economy in ``economy.py``:

- A new operator earns 1 point per cycle and starts with 100 energy, so the
  first full cell is about 100 points, plus a day-1 streak chest (10) and
  small quest or achievement grants.
- Bronze at 250 is past that first session.
- Silver at 2,500 is about ten Bronze thresholds: several days, or a node
  whose cycle yield has been upgraded.
- Gold at 15,000 is high. Cycle reward is capped at 250, so Gold still takes
  a long run of cycles and chests.
- Diamond at 60,000 is the prestige tier above Gold.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TierSpec:
    id: str
    label: str
    label_tr: str
    min_lifetime_points: int


TIERS: tuple[TierSpec, ...] = (
    TierSpec("bronze", "Bronze", "Bronz", 250),
    TierSpec("silver", "Silver", "Gümüş", 2_500),
    TierSpec("gold", "Gold", "Altın", 15_000),
    TierSpec("diamond", "Diamond", "Elmas", 60_000),
)

TIER_METRIC = "lifetimePoints"


def tier_for(lifetime_points: int) -> TierSpec | None:
    lifetime_points = int(lifetime_points)
    current: TierSpec | None = None
    for spec in TIERS:
        if lifetime_points >= spec.min_lifetime_points:
            current = spec
        else:
            break
    return current


def next_tier(lifetime_points: int) -> TierSpec | None:
    lifetime_points = int(lifetime_points)
    for spec in TIERS:
        if lifetime_points < spec.min_lifetime_points:
            return spec
    return None


def tiers_crossed(before: int, after: int) -> list[TierSpec]:
    before = int(before)
    after = int(after)
    if after <= before:
        return []
    return [spec for spec in TIERS if before < spec.min_lifetime_points <= after]


def public_tier(spec: TierSpec | None) -> dict | None:
    if spec is None:
        return None
    return {
        "id": spec.id,
        "label": spec.label,
        "labelTr": spec.label_tr,
        "minLifetimePoints": spec.min_lifetime_points,
    }


def threshold_payload() -> list[dict]:
    payload = []
    for spec in TIERS:
        item = public_tier(spec)
        if item is not None:
            payload.append(item)
    return payload


def tier_progress(lifetime_points: int) -> dict:
    lifetime_points = max(0, int(lifetime_points))
    current = tier_for(lifetime_points)
    nxt = next_tier(lifetime_points)
    floor = current.min_lifetime_points if current else 0
    if nxt is None:
        return {
            "metric": TIER_METRIC,
            "lifetimePoints": lifetime_points,
            "floor": floor,
            "ceiling": None,
            "pointsIntoSpan": 0,
            "pointsToNext": 0,
            "ratio": 1.0,
        }
    ceiling = nxt.min_lifetime_points
    span = ceiling - floor
    into = max(0, lifetime_points - floor)
    remaining = max(0, ceiling - lifetime_points)
    ratio = 0.0 if span <= 0 else min(1.0, into / span)
    return {
        "metric": TIER_METRIC,
        "lifetimePoints": lifetime_points,
        "floor": floor,
        "ceiling": ceiling,
        "pointsIntoSpan": into,
        "pointsToNext": remaining,
        "ratio": round(ratio, 6),
    }


def tier_view(lifetime_points: int) -> dict:
    lifetime_points = int(lifetime_points)
    return {
        "tier": public_tier(tier_for(lifetime_points)),
        "nextTier": public_tier(next_tier(lifetime_points)),
        "tierProgress": tier_progress(lifetime_points),
        "thresholds": threshold_payload(),
    }


def tier_race_line(lifetime_points: int) -> str:
    """Short Home/Rank copy. Numbers are lifetime points, not the selected board."""
    view = tier_view(lifetime_points)
    current = view["tier"]
    nxt = view["nextTier"]
    progress = view["tierProgress"]
    if nxt is None and current is not None:
        return f"{current['label']} is the top tier. {points_phrase(lifetime_points)} earned."
    if current is None and nxt is not None:
        return f"{points_phrase(progress['pointsToNext'])} to {nxt['label']} ({nxt['labelTr']})."
    if current is None or nxt is None:
        return "Tier progress is unavailable."
    return f"{points_phrase(progress['pointsToNext'])} from {current['label']} to {nxt['label']}."


def above_race_line(me_score: int, on_board: bool, above: dict | None) -> str:
    if above is None:
        if on_board:
            return "You hold #1 on this board."
        return "No operator is ahead of you on this board yet."
    gap = int(above["score"]) - int(me_score)
    name = above.get("displayName") or "The operator above you"
    if gap <= 0:
        return f"{name} is ranked ahead of you on this board with the same score."
    return f"{name} is {gap} {point_word(gap)} ahead of you on this board."


def points_phrase(amount: int) -> str:
    amount = int(amount)
    return f"{amount} {point_word(amount, lifetime=True)}"


def point_word(amount: int, *, lifetime: bool = False) -> str:
    noun = "Zyron Point" if int(amount) == 1 else "Zyron Points"
    if lifetime:
        return f"lifetime {noun}"
    return noun


def tier_distribution(conn) -> list[dict]:
    """Count operators currently in each named tier. Players below Bronze are omitted."""
    specs = list(TIERS)
    selects: list[str] = []
    params: list[int] = []
    for index, spec in enumerate(specs):
        if index + 1 < len(specs):
            nxt = specs[index + 1]
            selects.append(
                f"COUNT(*) FILTER (WHERE lifetime_points >= %s AND lifetime_points < %s)::int AS {spec.id}"
            )
            params.extend([spec.min_lifetime_points, nxt.min_lifetime_points])
        else:
            selects.append(f"COUNT(*) FILTER (WHERE lifetime_points >= %s)::int AS {spec.id}")
            params.append(spec.min_lifetime_points)
    row = conn.execute(f"SELECT {', '.join(selects)} FROM players", params).fetchone()
    return [
        {
            "id": spec.id,
            "label": spec.label,
            "labelTr": spec.label_tr,
            "minLifetimePoints": spec.min_lifetime_points,
            "players": int(row[spec.id] or 0),
        }
        for spec in specs
    ]

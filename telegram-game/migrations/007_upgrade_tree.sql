-- Upgrade tree, daily play-points limit, and the free daily chest bonus.
-- Safe to re-run: every change is IF NOT EXISTS.
-- Tree levels (capacity, recovery, efficiency) live in player_upgrades next to node modules.
-- Rewards are off-chain Zyron Points or cosmetics only. Nothing here can mint ZYN.

ALTER TABLE players ADD COLUMN IF NOT EXISTS play_points_day DATE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS play_points_today INTEGER NOT NULL DEFAULT 0 CHECK (play_points_today >= 0);

CREATE TABLE IF NOT EXISTS daily_chest_rolls (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    day DATE NOT NULL,
    roll INTEGER NOT NULL CHECK (roll >= 0 AND roll < 1000),
    outcome TEXT NOT NULL CHECK (outcome ~ '^[a-z0-9_]{1,24}$'),
    points INTEGER NOT NULL CHECK (points >= 0 AND points <= 50),
    cosmetic_id TEXT CHECK (cosmetic_id IS NULL OR cosmetic_id ~ '^[a-z0-9_]{1,32}$'),
    duplicate BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, day)
);

CREATE TABLE IF NOT EXISTS player_cosmetics (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    cosmetic_id TEXT NOT NULL CHECK (cosmetic_id ~ '^[a-z0-9_]{1,32}$'),
    source TEXT NOT NULL CHECK (source IN ('daily_chest', 'admin')),
    acquired_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, cosmetic_id)
);

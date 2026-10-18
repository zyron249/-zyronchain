-- Builder wardrobe. Cosmetic only: spending Zyron Points never changes cycle reward,
-- energy, or node level, and nothing here can mint ZYN.
-- Safe to re-run.

ALTER TABLE player_cosmetics DROP CONSTRAINT IF EXISTS player_cosmetics_source_check;
ALTER TABLE player_cosmetics ADD CONSTRAINT player_cosmetics_source_check
    CHECK (source IN ('daily_chest', 'admin', 'wallet_proof', 'season', 'points'));

CREATE TABLE IF NOT EXISTS player_loadout (
    player_id BIGINT PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
    helmet TEXT NOT NULL DEFAULT 'stock' CHECK (helmet ~ '^[a-z0-9_]{1,32}$'),
    pickaxe TEXT NOT NULL DEFAULT 'stock' CHECK (pickaxe ~ '^[a-z0-9_]{1,32}$'),
    color TEXT NOT NULL DEFAULT 'electric' CHECK (color ~ '^[a-z0-9_]{1,32}$'),
    wolf_mask BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

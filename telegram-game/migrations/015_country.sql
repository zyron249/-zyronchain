-- Optional country for the aggregate builder map.
-- NULL means the player has not opted in. No city, coordinates, or IP country are stored.
-- Safe to re-run.

ALTER TABLE players ADD COLUMN IF NOT EXISTS country_code TEXT
    CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');

CREATE INDEX IF NOT EXISTS players_country ON players (country_code) WHERE country_code IS NOT NULL;

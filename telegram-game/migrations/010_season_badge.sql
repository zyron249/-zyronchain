-- Seasonal cosmetic badges (Halloween 2026): granted once by the server inside its window, zero points.
ALTER TABLE player_cosmetics DROP CONSTRAINT IF EXISTS player_cosmetics_source_check;
ALTER TABLE player_cosmetics ADD CONSTRAINT player_cosmetics_source_check
    CHECK (source IN ('daily_chest', 'admin', 'wallet_proof', 'season'));

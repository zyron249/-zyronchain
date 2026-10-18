-- Player squads and the 7-day streak chain.
-- team_account stays the staff flag. These tables are opt-in builder squads.
-- Rewards are off-chain Zyron Points. Nothing here can mint ZYN.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS squads (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 3 AND 24),
    tag TEXT NOT NULL UNIQUE CHECK (tag ~ '^[A-Z0-9]{2,5}$'),
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS squad_members (
    player_id BIGINT PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
    squad_id BIGINT NOT NULL REFERENCES squads (id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('captain', 'member')),
    joined_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS squad_members_squad ON squad_members (squad_id);

-- Drop a squad once its last builder is gone, including when players are removed.
CREATE OR REPLACE FUNCTION delete_empty_squad() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM squads
    WHERE id = OLD.squad_id
      AND NOT EXISTS (SELECT 1 FROM squad_members WHERE squad_id = OLD.squad_id);
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS squad_members_empty ON squad_members;
CREATE TRIGGER squad_members_empty
    AFTER DELETE ON squad_members
    FOR EACH ROW EXECUTE FUNCTION delete_empty_squad();

CREATE TABLE IF NOT EXISTS streak_chain_claims (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    anchor DATE NOT NULL,
    day_index INTEGER NOT NULL CHECK (day_index BETWEEN 1 AND 7),
    points INTEGER NOT NULL CHECK (points > 0 AND points <= 8),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, anchor, day_index)
);

-- Daily cipher guesses and shared network events.
-- Points are off-chain Zyron Points. Nothing here can mint ZYN.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS cipher_guesses (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    day DATE NOT NULL,
    guess TEXT NOT NULL CHECK (guess ~ '^[A-Z]{3,12}$'),
    correct BOOLEAN NOT NULL,
    points INTEGER NOT NULL CHECK (points >= 0 AND points <= 8),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, day, guess)
);

CREATE TABLE IF NOT EXISTS network_events (
    event_key TEXT PRIMARY KEY CHECK (event_key ~ '^[a-z0-9:_-]{8,40}$'),
    kind TEXT NOT NULL CHECK (kind IN ('block_storm', 'bug_monster')),
    hp INTEGER NOT NULL CHECK (hp >= 0),
    max_hp INTEGER NOT NULL CHECK (max_hp > 0),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0),
    goal INTEGER NOT NULL CHECK (goal > 0),
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS network_event_strikes (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    event_key TEXT NOT NULL REFERENCES network_events (event_key) ON DELETE CASCADE,
    strike_no INTEGER NOT NULL CHECK (strike_no >= 1 AND strike_no <= 8),
    damage INTEGER NOT NULL CHECK (damage >= 0 AND damage <= 80),
    points INTEGER NOT NULL CHECK (points >= 0 AND points <= 40),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, event_key, strike_no)
);

CREATE TABLE IF NOT EXISTS network_event_claims (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    points INTEGER NOT NULL CHECK (points > 0 AND points <= 12),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, event_key)
);

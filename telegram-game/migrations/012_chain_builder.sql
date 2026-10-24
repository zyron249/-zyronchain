-- Chain Builder runs. The server stores the blueprint and the placed order.
-- Points are off-chain Zyron Points with a daily cap. Nothing here can mint ZYN.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS chain_builder_runs (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    day DATE NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1 AND attempt <= 12),
    sequence TEXT NOT NULL CHECK (sequence ~ '^[a-z,]{1,64}$'),
    placed TEXT CHECK (placed IS NULL OR placed ~ '^[a-z,]{1,64}$'),
    points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0 AND points <= 40),
    started_at TIMESTAMPTZ NOT NULL,
    settled_at TIMESTAMPTZ,
    PRIMARY KEY (player_id, day, attempt)
);

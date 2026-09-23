-- One-time level supply chests. Quest and streak chests use their existing tables.
-- Rewards are Zyron Points only. This table cannot mint ZYN.

CREATE TABLE chest_claims (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    chest_id TEXT NOT NULL CHECK (chest_id ~ '^level:[1-9][0-9]{0,1}$'),
    reward_points INTEGER NOT NULL CHECK (reward_points > 0),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, chest_id)
);

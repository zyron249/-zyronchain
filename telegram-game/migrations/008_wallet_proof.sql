-- Signed wallet link (testnet): one-time challenges, verified links, and a one-time cosmetic badge.
-- Safe to re-run. Nothing here stores keys or recovery phrases: only public keys, addresses and signatures.
-- The badge is cosmetic only. Verifying a wallet never pays Zyron Points and cannot mint ZYN.

ALTER TABLE players ADD COLUMN IF NOT EXISTS wallet_verified_at TIMESTAMPTZ;
ALTER TABLE wallet_claims ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS wallet_challenges (
    nonce TEXT PRIMARY KEY CHECK (nonce ~ '^[0-9a-f]{32}$'),
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    telegram_id BIGINT NOT NULL CHECK (telegram_id > 0),
    message TEXT NOT NULL CHECK (char_length(message) <= 1024),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    outcome TEXT CHECK (outcome IS NULL OR outcome ~ '^[a-z_]{1,32}$'),
    address TEXT CHECK (address IS NULL OR address ~ '^ZYN[0-9a-f]{40}$')
);
CREATE INDEX IF NOT EXISTS wallet_challenges_player_time ON wallet_challenges (player_id, created_at DESC);

ALTER TABLE wallet_events DROP CONSTRAINT IF EXISTS wallet_events_action_check;
ALTER TABLE wallet_events ADD CONSTRAINT wallet_events_action_check
    CHECK (action IN ('link', 'unlink', 'verify', 'superseded'));

ALTER TABLE player_cosmetics DROP CONSTRAINT IF EXISTS player_cosmetics_source_check;
ALTER TABLE player_cosmetics ADD CONSTRAINT player_cosmetics_source_check
    CHECK (source IN ('daily_chest', 'admin', 'wallet_proof'));

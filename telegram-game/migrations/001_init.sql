-- ZYRON NODE off-chain game schema.
-- This database is not chain state and cannot mint ZYN.

CREATE TABLE players (
    id BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL UNIQUE CHECK (telegram_id > 0),
    username TEXT,
    display_name TEXT NOT NULL DEFAULT '',
    referral_code TEXT NOT NULL UNIQUE CHECK (referral_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$'),
    referred_by_id BIGINT REFERENCES players (id),
    wallet_address TEXT UNIQUE CHECK (wallet_address IS NULL OR wallet_address ~ '^ZYN[0-9a-f]{40}$'),
    wallet_linked_at TIMESTAMPTZ,
    points BIGINT NOT NULL DEFAULT 0 CHECK (points >= 0),
    lifetime_points BIGINT NOT NULL DEFAULT 0 CHECK (lifetime_points >= 0),
    energy INTEGER NOT NULL CHECK (energy >= 0 AND energy <= 10000),
    energy_updated_at TIMESTAMPTZ NOT NULL,
    streak_count INTEGER NOT NULL DEFAULT 0 CHECK (streak_count >= 0),
    streak_last_date DATE,
    longest_streak INTEGER NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
    cycle_count BIGINT NOT NULL DEFAULT 0 CHECK (cycle_count >= 0),
    node_level INTEGER NOT NULL DEFAULT 1 CHECK (node_level >= 1),
    banned BOOLEAN NOT NULL DEFAULT FALSE,
    abuse_score INTEGER NOT NULL DEFAULT 0 CHECK (abuse_score >= 0),
    signup_ip_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    last_cycle_at TIMESTAMPTZ
);

CREATE TABLE player_upgrades (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    module TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
    PRIMARY KEY (player_id, module)
);

CREATE TABLE point_ledger (
    id BIGSERIAL PRIMARY KEY,
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    amount BIGINT NOT NULL CHECK (amount <> 0),
    reason TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    season_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX point_ledger_player_time ON point_ledger (player_id, created_at);
CREATE INDEX point_ledger_positive_time ON point_ledger (created_at) WHERE amount > 0;
CREATE INDEX point_ledger_season_positive ON point_ledger (season_id) WHERE amount > 0;

CREATE TABLE idempotency_keys (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, scope, key)
);

CREATE TABLE quest_claims (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    quest_id TEXT NOT NULL,
    period_key TEXT NOT NULL,
    reward_points INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, quest_id, period_key)
);

CREATE TABLE player_achievements (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    achievement_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, achievement_id)
);

CREATE TABLE referrals (
    id BIGSERIAL PRIMARY KEY,
    referrer_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    referee_id BIGINT NOT NULL UNIQUE REFERENCES players (id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'rewarded', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL,
    rewarded_at TIMESTAMPTZ
);

CREATE INDEX referrals_referrer_status ON referrals (referrer_id, status, created_at);

CREATE TABLE abuse_flags (
    id BIGSERIAL PRIMARY KEY,
    player_id BIGINT REFERENCES players (id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    detail TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ
);

CREATE INDEX abuse_flags_open ON abuse_flags (created_at) WHERE resolved_at IS NULL;

CREATE TABLE player_markers (
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    marker TEXT NOT NULL,
    period_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, marker, period_key)
);

CREATE TABLE wallet_claims (
    address TEXT PRIMARY KEY CHECK (address ~ '^ZYN[0-9a-f]{40}$'),
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    claimed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE wallet_events (
    id BIGSERIAL PRIMARY KEY,
    player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('link', 'unlink')),
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX wallet_events_player_time ON wallet_events (player_id, created_at DESC);

CREATE TABLE pending_referrals (
    telegram_id BIGINT PRIMARY KEY CHECK (telegram_id > 0),
    referral_code TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE seasons (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('scheduled', 'active', 'closed')),
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE season_snapshots (
    id BIGSERIAL PRIMARY KEY,
    season_id BIGINT NOT NULL REFERENCES seasons (id),
    created_at TIMESTAMPTZ NOT NULL,
    note TEXT NOT NULL,
    payload JSONB NOT NULL
);

CREATE TABLE chain_cache (
    cache_key TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE rate_limits (
    bucket_key TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    hits INTEGER NOT NULL CHECK (hits >= 0),
    PRIMARY KEY (bucket_key, window_start)
);

CREATE TABLE admin_audit (
    id BIGSERIAL PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO seasons (name, status, starts_at, ends_at, created_at)
VALUES ('Season 0', 'active', '2026-09-01T00:00:00Z', NULL, '2026-09-01T00:00:00Z');

-- ZYRON HUB web sign-in (read-only). The bot issues a one-time code inside Telegram; the browser exchanges it
-- for a short-lived session. Only SHA-256 hashes of the browser secret, the code and the session token are
-- stored. Safe to re-run.

CREATE TABLE IF NOT EXISTS web_logins (
    login_id TEXT PRIMARY KEY CHECK (login_id ~ '^[0-9a-f]{32}$'),
    secret_hash TEXT NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    telegram_id BIGINT CHECK (telegram_id IS NULL OR telegram_id > 0),
    code_hash TEXT CHECK (code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$'),
    code_issued_at TIMESTAMPTZ,
    code_expires_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    used_at TIMESTAMPTZ,
    outcome TEXT CHECK (outcome IS NULL OR outcome ~ '^[a-z_]{1,32}$')
);
CREATE INDEX IF NOT EXISTS web_logins_created ON web_logins (created_at);

CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    telegram_id BIGINT NOT NULL CHECK (telegram_id > 0),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS web_sessions_telegram ON web_sessions (telegram_id);

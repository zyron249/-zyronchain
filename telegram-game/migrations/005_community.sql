-- Community group features: scheduled leaderboard posts, weekly quiz, welcome cleanup.
-- Safe to re-run: every change is IF NOT EXISTS.

-- One row per scheduled post (daily board, weekly summary, quiz, welcome). The primary key
-- makes every post idempotent across restarts and overlapping deploys.
CREATE TABLE IF NOT EXISTS community_posts (
    kind TEXT NOT NULL CHECK (kind ~ '^[a-z_]{1,20}$'),
    period_key TEXT NOT NULL CHECK (length(period_key) BETWEEN 1 AND 40),
    status TEXT NOT NULL CHECK (status IN ('claimed', 'posted', 'skipped', 'failed')),
    message_id BIGINT,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (kind, period_key)
);

CREATE INDEX IF NOT EXISTS community_posts_kind_time ON community_posts (kind, created_at);

CREATE TABLE IF NOT EXISTS quiz_polls (
    poll_id TEXT PRIMARY KEY,
    quiz_key TEXT NOT NULL,
    question_id TEXT NOT NULL,
    correct_option INTEGER NOT NULL CHECK (correct_option >= 0),
    chat_id TEXT NOT NULL,
    message_id BIGINT NOT NULL,
    opens_at TIMESTAMPTZ NOT NULL,
    closes_at TIMESTAMPTZ NOT NULL,
    stopped BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS quiz_polls_open ON quiz_polls (closes_at) WHERE stopped = FALSE;

-- One attempt per user per question; points are decided here, never by the client.
CREATE TABLE IF NOT EXISTS quiz_answers (
    poll_id TEXT NOT NULL REFERENCES quiz_polls (poll_id) ON DELETE CASCADE,
    telegram_id BIGINT NOT NULL CHECK (telegram_id > 0),
    option_index INTEGER NOT NULL,
    correct BOOLEAN NOT NULL,
    points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
    answered_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (poll_id, telegram_id)
);

-- Only the bot's own welcome messages are queued here for deletion.
CREATE TABLE IF NOT EXISTS pending_deletes (
    chat_id TEXT NOT NULL,
    message_id BIGINT NOT NULL,
    delete_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (chat_id, message_id)
);

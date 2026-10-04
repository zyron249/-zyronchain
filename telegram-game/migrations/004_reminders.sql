-- Reminder DMs. Safe to re-run: every change is IF NOT EXISTS.
-- chat_id is the player's private chat with the bot. It is recorded only when the
-- player messages the bot or opens the Mini App with allows_write_to_pm = true.

ALTER TABLE players ADD COLUMN IF NOT EXISTS chat_id BIGINT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS reminders_opt_out BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS reminders_unreachable_at TIMESTAMPTZ;
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ;
ALTER TABLE players ADD COLUMN IF NOT EXISTS energy_reminded_at TIMESTAMPTZ;
ALTER TABLE players ADD COLUMN IF NOT EXISTS chest_reminded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS players_reminder_candidates
    ON players (last_seen_at)
    WHERE chat_id IS NOT NULL AND reminders_opt_out = FALSE AND reminders_unreachable_at IS NULL AND banned = FALSE;

-- One row per background job, written by the bot process on every tick so the
-- admin API can confirm the loop is alive on Render.
CREATE TABLE IF NOT EXISTS bot_jobs (
    name TEXT PRIMARY KEY CHECK (name ~ '^[a-z0-9_]{1,40}$'),
    last_run_at TIMESTAMPTZ NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

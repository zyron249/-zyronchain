-- Team/project accounts: they can play, but are never ranked or reward-eligible.
-- Safe to re-run: every change is IF NOT EXISTS.
-- Set by TEAM_TELEGRAM_IDS on startup or by POST /api/admin/players/{id}/team.

ALTER TABLE players ADD COLUMN IF NOT EXISTS team_account BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS team_marked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS players_team_accounts ON players (id) WHERE team_account = TRUE;

-- Append-only competitive activity ledger.
-- Rows are the audit source for a future fair distribution of off-chain points.
-- This table cannot mint ZYN. Game code inserts rows and does not rewrite them.

CREATE TABLE activity_ledger (
    id BIGSERIAL PRIMARY KEY,
    player_id BIGINT NOT NULL REFERENCES players (id),
    telegram_id BIGINT NOT NULL CHECK (telegram_id > 0),
    event_type TEXT NOT NULL CHECK (event_type ~ '^[a-z0-9_]{1,40}$'),
    amount BIGINT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX activity_ledger_player_time ON activity_ledger (player_id, created_at);
CREATE INDEX activity_ledger_type_time ON activity_ledger (event_type, created_at);
CREATE INDEX activity_ledger_telegram_time ON activity_ledger (telegram_id, created_at);

CREATE OR REPLACE FUNCTION activity_ledger_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'activity_ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS activity_ledger_append_only ON activity_ledger;

CREATE TRIGGER activity_ledger_append_only
BEFORE UPDATE OR DELETE ON activity_ledger
FOR EACH ROW
EXECUTE FUNCTION activity_ledger_reject_mutation();

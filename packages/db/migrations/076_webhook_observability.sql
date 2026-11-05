-- Migration: Webhook observability and security enhancements
-- Adds tracking for webhook signature verification events and inbound silence monitoring.

-- Track per-account last inbound (successful webhook) and last signature mismatch
-- for observability without exposing secrets.
ALTER TABLE line_accounts ADD COLUMN last_inbound_at TEXT;
ALTER TABLE line_accounts ADD COLUMN last_signature_mismatch_at TEXT;
ALTER TABLE line_accounts ADD COLUMN secret_updated_at TEXT;

-- Aggregate webhook signature stats for API exposure.
-- Tracks total inbound count and signature mismatch count per account per day.
-- Allows ops to see silence without guessing.
CREATE TABLE IF NOT EXISTS webhook_signature_stats (
  id                   TEXT PRIMARY KEY,
  line_account_id      TEXT REFERENCES line_accounts(id) ON DELETE CASCADE,
  stat_date            TEXT NOT NULL, -- YYYY-MM-DD in JST
  inbound_count        INTEGER NOT NULL DEFAULT 0,
  signature_mismatch_count INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(line_account_id, stat_date)
);

-- Global stats row for signature mismatches that don't match any account
-- (line_account_id IS NULL represents "no account matched").
CREATE INDEX IF NOT EXISTS idx_webhook_signature_stats_account_date
  ON webhook_signature_stats (line_account_id, stat_date DESC);

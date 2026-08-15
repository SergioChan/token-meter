CREATE TABLE IF NOT EXISTS registry_meters (
  meter_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  handle TEXT UNIQUE,
  days JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  week_tokens BIGINT NOT NULL DEFAULT 0,
  generated_at_ms BIGINT,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS registry_handles (
  handle VARCHAR(30) PRIMARY KEY,
  meter_id TEXT NOT NULL UNIQUE REFERENCES registry_meters(meter_id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  claimed_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS registry_meters_week_tokens_idx
  ON registry_meters (week_tokens DESC, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS registry_browser_pairings (
  code_hash CHAR(64) PRIMARY KEY,
  meter_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  consumed_at_ms BIGINT
);

CREATE INDEX IF NOT EXISTS registry_browser_pairings_expires_idx
  ON registry_browser_pairings (expires_at_ms);

CREATE TABLE IF NOT EXISTS registry_browser_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  meter_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS registry_browser_sessions_expires_idx
  ON registry_browser_sessions (expires_at_ms);

CREATE TABLE IF NOT EXISTS registry_profiles (
  profile_id TEXT PRIMARY KEY,
  owner_meter_id TEXT NOT NULL UNIQUE
    REFERENCES registry_meters(meter_id) ON DELETE RESTRICT,
  handle VARCHAR(30) UNIQUE,
  days JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  week_tokens BIGINT NOT NULL DEFAULT 0,
  generated_at_ms BIGINT,
  updated_at_ms BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  rollup_version INTEGER NOT NULL DEFAULT 1,
  time_zone TEXT,
  CHECK (handle IS NULL OR handle = lower(handle))
);

CREATE INDEX IF NOT EXISTS registry_profiles_week_tokens_idx
  ON registry_profiles (week_tokens DESC, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS registry_profile_devices (
  profile_id TEXT NOT NULL
    REFERENCES registry_profiles(profile_id) ON DELETE CASCADE,
  meter_id TEXT NOT NULL UNIQUE
    REFERENCES registry_meters(meter_id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'member',
  sharing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at_ms BIGINT NOT NULL,
  last_reported_at_ms BIGINT,
  revoked_at_ms BIGINT,
  replaced_by_meter_id TEXT
    REFERENCES registry_meters(meter_id) ON DELETE RESTRICT,
  device_label VARCHAR(80),
  PRIMARY KEY (profile_id, meter_id),
  CHECK (role IN ('owner', 'member')),
  CHECK (device_label IS NULL OR device_label <> ''),
  CHECK (replaced_by_meter_id IS NULL OR replaced_by_meter_id <> meter_id)
);

CREATE INDEX IF NOT EXISTS registry_profile_devices_profile_idx
  ON registry_profile_devices (profile_id, revoked_at_ms);

CREATE TABLE IF NOT EXISTS registry_device_invites (
  token_hash CHAR(64) PRIMARY KEY,
  profile_id TEXT NOT NULL
    REFERENCES registry_profiles(profile_id) ON DELETE CASCADE,
  created_by_meter_id TEXT NOT NULL
    REFERENCES registry_meters(meter_id) ON DELETE RESTRICT,
  mode TEXT NOT NULL DEFAULT 'add',
  replace_meter_id TEXT
    REFERENCES registry_meters(meter_id) ON DELETE RESTRICT,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  consumed_at_ms BIGINT,
  joined_meter_id TEXT
    REFERENCES registry_meters(meter_id) ON DELETE RESTRICT,
  CHECK (mode IN ('add', 'replace')),
  CHECK (expires_at_ms > created_at_ms),
  CHECK (
    (mode = 'add' AND replace_meter_id IS NULL) OR
    (mode = 'replace' AND replace_meter_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS registry_device_invites_expires_idx
  ON registry_device_invites (expires_at_ms);

ALTER TABLE registry_handles
  ADD COLUMN IF NOT EXISTS profile_id TEXT
    REFERENCES registry_profiles(profile_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS registry_handles_profile_id_idx
  ON registry_handles (profile_id)
  WHERE profile_id IS NOT NULL;

INSERT INTO registry_profiles (
  profile_id,
  owner_meter_id,
  handle,
  days,
  stats,
  week_tokens,
  generated_at_ms,
  updated_at_ms,
  created_at_ms
)
SELECT
  m.meter_id,
  m.meter_id,
  h.handle,
  m.days,
  m.stats,
  m.week_tokens,
  m.generated_at_ms,
  m.updated_at_ms,
  COALESCE(h.claimed_at_ms, m.updated_at_ms)
FROM registry_meters AS m
LEFT JOIN registry_handles AS h ON h.meter_id = m.meter_id
ON CONFLICT (profile_id) DO NOTHING;

INSERT INTO registry_profile_devices (
  profile_id,
  meter_id,
  role,
  sharing_enabled,
  joined_at_ms,
  last_reported_at_ms
)
SELECT
  m.meter_id,
  m.meter_id,
  'owner',
  m.generated_at_ms IS NOT NULL,
  COALESCE(h.claimed_at_ms, m.updated_at_ms),
  CASE WHEN m.generated_at_ms IS NULL THEN NULL ELSE m.updated_at_ms END
FROM registry_meters AS m
JOIN registry_profiles AS p ON p.profile_id = m.meter_id
LEFT JOIN registry_handles AS h ON h.meter_id = m.meter_id
ON CONFLICT (meter_id) DO NOTHING;

UPDATE registry_handles
SET profile_id = meter_id
WHERE meter_id IN (SELECT profile_id FROM registry_profiles);

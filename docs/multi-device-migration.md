# Multi-device Profile migration runbook

This is the production procedure for moving the Token Widget registry from one public Meter per computer to one public Profile with one or more independently signed Device memberships.

The production registry currently runs on GKE Autopilot and uses PostgreSQL in the Cloud SQL instance `tworld-473700:us-west1:token-widget`. `www.tokenwidget.app` proxies API traffic to `api.tokenwidget.app`; Vercel does not own the database migration.

Do not improvise the ordering. Every stage has a stop/go gate, and Profile-backed reads remain disabled until all migration and reconciliation checks pass.

## What changes

Migration `002_profiles_and_devices` is additive. It creates:

- `registry_profiles` — one public rollup and globally unique optional handle;
- `registry_profile_devices` — one membership per existing or new Meter ID;
- `registry_device_invites` — hashed, expiring, one-use invitations;
- `registry_handles.profile_id` — a nullable foreign key plus a unique Profile index.

It does not drop, rename, truncate, or rewrite the legacy Meter, pairing, or browser-session tables. Every existing Meter is backfilled as a one-device Profile whose owner and Profile ID are that Meter ID. Existing Profile output must therefore be byte-for-byte equivalent at the aggregate JSON level before any second device is linked.

## Risk assessment

| Risk | Level before controls | Control and residual risk |
| --- | --- | --- |
| Accidental data loss from schema change | Low | The SQL is additive and transactional. An on-demand backup and confirmed PITR window are hard gates. No down-migration is supplied. |
| Brief PostgreSQL lock during `ALTER TABLE` and index creation | Low at current scale | Run in a low-traffic window. Current production has only a handful of rows; nevertheless, watch API latency and abort if the transaction cannot acquire its lock promptly. |
| Old Pod writes after backfill | Medium | New code is deployed with Profile reads off, old writes remain accepted, and `reconcile` locks Meter then membership rows, mirrors signed v1 state, attaches late owner handle claims, and rebuilds stale rollups. Run it after every rollout boundary. |
| Duplicate or missing Profile totals | Medium | `verify` independently reconstructs every rollup from active non-revoked devices. Profile reads stay off if any mismatch is nonzero. |
| Duplicate history after adding a computer | Medium product risk | Session IDs and hostnames are not uploaded, so overlapping synced history cannot be de-duplicated centrally. Use **Replace** for a computer migration; use **Add** only when both histories should be summed. |
| Handle theft or duplicate handle | Low | The existing handle primary key remains the global uniqueness authority. Joining never claims a handle. Only the active owner can issue an invitation, and the invitation is random, hashed, one-use, and expires after ten minutes. |
| Rollback after new devices join | Medium | Disabling Profile reads is immediate and does not delete new rows. Legacy reads show only legacy owner Meter data until Profile reads return. A destructive database restore is reserved for actual corruption. |
| Numeric overflow while summing devices | Low | Rollups accept non-negative safe integers only and reject overflow instead of storing a rounded number. |

The migration itself is low risk at the current data volume. The important risks are operational ordering and cross-device overlap, not table size.

## Hard gates

Do not begin Stage 1 unless all of these are true:

- The exact release commit passed `npm run ci`.
- The container image was built from that commit and pinned by digest.
- The current production API baseline was captured.
- Cloud SQL automated backups are enabled.
- Cloud SQL reports `pointInTimeRecoveryEnabled: true` with a non-empty recovery window.
- A new on-demand backup completed successfully.
- A restore drill to a separate temporary instance has succeeded recently, preferably using the just-created backup or a pre-migration PITR timestamp.
- `TOKEN_WIDGET_PROFILE_READS` is absent or explicitly `0` in the first deployment.
- No multi-device client or invitation has been released yet.
- One operator owns the migration terminal and records every command, timestamp, image digest, backup ID, and verification JSON.

If PITR is disabled, stop. Enabling PITR on an existing Cloud SQL instance can restart it; do that in a separate maintenance change, then confirm the recovery window before returning to this runbook.

Official references:

- [Cloud SQL: configure PostgreSQL PITR](https://cloud.google.com/sql/docs/postgres/backup-recovery/configure-pitr)
- [Cloud SQL: create an on-demand backup](https://cloud.google.com/sdk/gcloud/reference/sql/backups/create)
- [Cloud SQL: perform PITR into a clone](https://cloud.google.com/sql/docs/postgres/backup-recovery/pitr)
- [Cloud SQL backup and recovery best practices](https://cloud.google.com/sql/docs/postgres/best-practices#backup_recovery)

## Stage 0 — release candidate and rehearsal

1. Record the release commit and run the full suite:

   ```bash
   git rev-parse HEAD
   npm ci
   npm run ci
   git diff --check
   ```

2. Build and push a unique image as described in [the GKE deployment guide](../deploy/gke/README.md). Pin the returned digest in `deploy/gke/token-widget.yaml`; never deploy a mutable tag.

3. Rehearse the migration against a temporary restore or sanitized PostgreSQL copy:

   ```bash
   DATABASE_URL='postgresql://…temporary-database…' npm run registry:migrate:status
   DATABASE_URL='postgresql://…temporary-database…' npm run registry:migrate
   DATABASE_URL='postgresql://…temporary-database…' npm run registry:migrate:reconcile
   DATABASE_URL='postgresql://…temporary-database…' npm run registry:migrate:verify
   ```

4. Require the final command to return `"ok": true`. Run `reconcile` and `verify` a second time; the second reconciliation must be empty and migration status must remain `applied` with matching checksums.

Do not place a production connection string in shell history, logs, a commit, or a ticket. Production commands below execute inside the registry Pod, where `DATABASE_URL` already comes from the Kubernetes Secret.

## Stage 1 — prove recovery and capture baseline

### 1.1 Inspect data protection

```bash
gcloud sql instances describe token-widget \
  --project tworld-473700 \
  --format='yaml(name,state,databaseVersion,settings.backupConfiguration,settings.deletionProtectionEnabled)'

gcloud sql instances get-latest-recovery-time token-widget \
  --project tworld-473700
```

Record the output. The backup configuration must be enabled, PITR must be true, and the intended pre-migration UTC timestamp must lie inside the returned recovery window.

### 1.2 Create an on-demand backup

```bash
gcloud sql backups create \
  --instance token-widget \
  --project tworld-473700 \
  --description "pre-multidevice-profile-migration"

gcloud sql backups list \
  --instance token-widget \
  --project tworld-473700 \
  --limit 5
```

Do not continue until the new backup reports `SUCCESSFUL`. Standard on-demand Cloud SQL backups are retained until explicitly deleted; do not remove this backup during the observation period.

### 1.3 Capture the public baseline

Use a new temporary directory so the before/after responses can be retained with the deployment record without mixing them into the repository:

```bash
TOKEN_WIDGET_MIGRATION_AUDIT="$(mktemp -d)"

curl -fsS https://api.tokenwidget.app/api/v1/health \
  > "$TOKEN_WIDGET_MIGRATION_AUDIT/health-before.json"
curl -fsS https://api.tokenwidget.app/api/v1/leaderboard \
  > "$TOKEN_WIDGET_MIGRATION_AUDIT/leaderboard-before.json"
curl -fsS https://api.tokenwidget.app/api/v1/profile/sergio \
  > "$TOKEN_WIDGET_MIGRATION_AUDIT/sergio-before.json"

jq . "$TOKEN_WIDGET_MIGRATION_AUDIT/health-before.json"
jq '{rows: (.rows | length), handles: [.rows[].handle]}' \
  "$TOKEN_WIDGET_MIGRATION_AUDIT/leaderboard-before.json"
jq '{handle, shared, weekTokens, days: (.days | length), stats}' \
  "$TOKEN_WIDGET_MIGRATION_AUDIT/sergio-before.json"
```

The development audit on 2026-08-15 observed four Meters and four public handles. That is historical context, not a deployment assertion: the files captured immediately above are the source of truth for this migration.

Stop if health is not green, any expected handle is missing, or the public Profile is malformed before migration.

## Stage 2 — deploy compatible server code with Profile reads off

The new server can run against the legacy schema. With Profile reads off it continues serving v1 Meter-backed public responses. The v2 membership endpoints return unavailable until migration 2 exists.

1. Confirm the initial manifest does not enable Profile reads:

   ```bash
   rg -n 'TOKEN_WIDGET_PROFILE_READS' deploy/gke/token-widget.yaml
   ```

   The value must be absent or `"0"`.

2. Validate and deploy the digest-pinned release candidate:

   ```bash
   kubectl apply --server-side --dry-run=server -f deploy/gke/token-widget.yaml
   kubectl apply -f deploy/gke/token-widget.yaml
   kubectl -n token-widget rollout status deployment/token-widget-registry
   ```

3. Confirm every active registry container uses the intended digest and that the public v1 API still matches the Stage 1 baseline:

   ```bash
   kubectl -n token-widget get pods \
     -l app.kubernetes.io/name=token-widget-registry \
     -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.status.containerStatuses[?(@.name=="registry")].imageID}{"\n"}{end}'

   curl -fsS https://api.tokenwidget.app/api/v1/health
   curl -fsS https://api.tokenwidget.app/api/v1/leaderboard | jq '.rows | length'
   ```

Stop and roll back the image if v1 behavior changed. No database migration has happened yet.

## Stage 3 — apply the additive migration

Run migration commands inside the new registry container. They use the existing Secret-backed `DATABASE_URL` and the Pod's Cloud SQL Auth Proxy.

### 3.1 Read-only status

```bash
kubectl -n token-widget exec deployment/token-widget-registry \
  -c registry -- npm run registry:migrate:status
```

Expected before the first run:

- migration 1 is `pending` on a legacy database without the migration ledger, but will be baselined rather than recreating its tables;
- migration 2 is `pending`;
- there is no `checksum-mismatch`.

### 3.2 Transactional apply, reconcile, and verify

Record a UTC timestamp immediately before the write:

```bash
date -u +'%Y-%m-%dT%H:%M:%SZ'

kubectl -n token-widget exec deployment/token-widget-registry \
  -c registry -- npm run registry:migrate
```

The command:

1. acquires a PostgreSQL advisory lock;
2. starts one transaction;
3. creates/checks the migration ledger;
4. baselines the already-existing v1 schema with an immutable checksum;
5. applies migration 2 and backfills one Profile/owner Device per Meter;
6. commits;
7. reconciles late v1 writes;
8. verifies structure and every Profile rollup.

It is safe to rerun after a lost terminal because applied checksums are immutable and every DDL/backfill statement is idempotent. Do not edit an applied SQL file to “fix forward”; add a new numbered migration.

### 3.3 Required verification shape

The final JSON must contain:

```json
{
  "verification": {
    "ok": true,
    "checks": {
      "metersWithoutDevice": 0,
      "devicesWithoutProfile": 0,
      "profilesWithoutOwnerMembership": 0,
      "unexpectedOwnerMemberships": 0,
      "deviceSharingStateMismatches": 0,
      "handlesWithoutProfile": 0,
      "handleProfileMismatches": 0,
      "rollupMismatches": 0
    }
  }
}
```

Immediately after backfill and before any device joins:

- `profiles` must equal `meters`;
- `devices` must equal `meters`;
- `handles` must equal the Stage 1 handle count;
- every mismatch count must be zero.

If the command fails before commit, the transaction rolls back. If it commits but verification fails, leave Profile reads off, preserve the output, and run only diagnostic queries until the cause is understood.

## Stage 4 — restart into shadow dual-write and close rolling races

Registry processes that started before migration cached “Profile schema unavailable.” Restart the Deployment, still with reads off, so every new process detects the schema and dual-writes each signed report to its Meter plus Profile rollup.

```bash
kubectl -n token-widget rollout restart deployment/token-widget-registry
kubectl -n token-widget rollout status deployment/token-widget-registry

kubectl -n token-widget exec deployment/token-widget-registry \
  -c registry -- npm run registry:migrate:reconcile

kubectl -n token-widget exec deployment/token-widget-registry \
  -c registry -- npm run registry:migrate:verify
```

`reconcile` deliberately handles all rolling-window cases:

- a new Meter written by a late v1 Pod;
- a report or withdrawal written only to an existing Meter;
- a late owner handle claim whose `profile_id` is still null;
- a stale Profile rollup.

It never reactivates a revoked or replaced device. A second immediate `reconcile` should return empty arrays, and `verify` must return `ok: true`.

Keep v1 public reads active for at least one normal client sync interval (60–90 minutes). During the shadow period:

- watch API error rate, p95 latency, Pod restarts, and Cloud SQL CPU/connections;
- run `registry:migrate:reconcile` and `registry:migrate:verify` after at least one upload cycle;
- compare the public v1 baseline again;
- do not issue a device invitation yet.

Any nonzero mismatch resets the observation window.

## Stage 5 — cut public reads over to Profiles

Only after Stage 4 remains clean:

```bash
kubectl -n token-widget set env deployment/token-widget-registry \
  TOKEN_WIDGET_PROFILE_READS=1

kubectl -n token-widget rollout status deployment/token-widget-registry
```

Then capture and compare after-state:

```bash
curl -fsS https://api.tokenwidget.app/api/v1/health \
  > "$TOKEN_WIDGET_MIGRATION_AUDIT/health-after.json"
curl -fsS https://api.tokenwidget.app/api/v1/leaderboard \
  > "$TOKEN_WIDGET_MIGRATION_AUDIT/leaderboard-after.json"
curl -fsS https://api.tokenwidget.app/api/v1/profile/sergio \
  > "$TOKEN_WIDGET_MIGRATION_AUDIT/sergio-after.json"

jq -S . "$TOKEN_WIDGET_MIGRATION_AUDIT/sergio-before.json" \
  > "$TOKEN_WIDGET_MIGRATION_AUDIT/sergio-before.sorted.json"
jq -S . "$TOKEN_WIDGET_MIGRATION_AUDIT/sergio-after.json" \
  > "$TOKEN_WIDGET_MIGRATION_AUDIT/sergio-after.sorted.json"

diff -u \
  "$TOKEN_WIDGET_MIGRATION_AUDIT/sergio-before.sorted.json" \
  "$TOKEN_WIDGET_MIGRATION_AUDIT/sergio-after.sorted.json"

kubectl -n token-widget exec deployment/token-widget-registry \
  -c registry -- npm run registry:migrate:verify
```

Small timestamp or live-rank movement caused by a legitimate concurrent report can be reviewed, but handle ownership, days, totals, Session counts, and platform aggregates must not disappear or jump unexpectedly. Before a second device joins, Profile reads should be observationally equivalent to Meter reads.

After successful cutover, update the declarative GKE manifest to include `TOKEN_WIDGET_PROFILE_READS=1`; do not leave production dependent on an uncommitted `kubectl set env` override.

Observe for another 60 minutes before releasing the multi-device client.

## Stage 6 — release the client and perform one controlled join

Release or install the new client only after the server cutover is stable.

For the first production exercise:

1. Use the owner computer for `@sergio` to create an **Add** invitation.
2. Join exactly one known second computer with a clear device label.
3. Keep sharing off on the new computer and verify membership/device listing first.
4. Enable sharing on the new computer only after checking whether its local history overlaps the owner computer.
5. If it replaces an old computer, cancel the Add flow and issue a **Replace** invitation instead.
6. Verify one public Profile row, the expected combined totals, and `rollupMismatches: 0`.
7. Test owner-only authorization, invitation replay rejection, and member revocation before broad release.

Do not copy the owner's private key or identity file to the second computer.

## Rollback

### Read-path rollback — preferred

If any public Profile output is wrong but legacy Meter data is intact:

```bash
kubectl -n token-widget set env deployment/token-widget-registry \
  TOKEN_WIDGET_PROFILE_READS=0

kubectl -n token-widget rollout status deployment/token-widget-registry
```

This is fast and non-destructive. The additive tables remain for diagnosis, signed writes remain in legacy Meter rows, and reconciliation can be rerun after a fix.

If clients have already joined multiple devices, legacy reads expose only the legacy owner Meter rather than the combined Profile. That is an availability/accuracy degradation, not data deletion.

### Application-image rollback

Roll back to the previously pinned image only if the new application itself is unhealthy. Keep Profile reads off first. The old image ignores additive tables and continues writing v1 Meter rows. Before returning to the new image, run `reconcile` and `verify` to absorb every old-image write.

### Database recovery — corruption only

Do not drop the new tables and do not restore the primary merely because a read flag or application rollback works. A database restore discards legitimate writes after the restore timestamp and has a much larger blast radius.

For confirmed corruption:

1. record the exact pre-migration or pre-corruption UTC timestamp;
2. stop registry writes;
3. create a separate PITR clone rather than overwriting the source instance;
4. validate counts, handles, signatures, and public API behavior against the audit files;
5. repoint production only after an explicit recovery review.

For standard Cloud SQL backups, the official clone form is:

```bash
gcloud sql instances clone token-widget \
  token-widget-recovery-YYYYMMDD \
  --project tworld-473700 \
  --point-in-time 'YYYY-MM-DDTHH:MM:SS.sssZ'
```

Enhanced-backup instances use `gcloud sql instances point-in-time-restore` with the backup-vault data source instead. Confirm the instance's backup type before choosing a command.

## Completion record

The migration is complete only when the release record contains:

- release commit and image digest;
- Cloud SQL data-protection output;
- on-demand backup ID and successful state;
- tested recovery timestamp or restore-drill instance;
- before/after API audit files;
- first and final migration status JSON;
- two consecutive empty reconciliation results;
- final `verification.ok: true`;
- exact time Profile reads were enabled;
- observation-window metrics;
- controlled first-device join result;
- rollback owner and decision threshold.

Keep the pre-migration backup through the full client rollout and observation period.

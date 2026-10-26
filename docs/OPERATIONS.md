# Operating Grafito

This is the runbook for running Grafito with Docker Compose: configuration,
backups, restore, secret rotation, and what to do when something is down.

## Configuration

Put secrets in a `.env` file next to `docker-compose.yml`. It isn't versioned.
The defaults in the compose file are for local testing only.

```dotenv
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=https://notes.example.com
GRAFITO_ENCRYPTION_KEY=<openssl rand -base64 48>
POSTGRES_PASSWORD=<a long random password>
S3_SECRET_KEY=<a long random password>
```

Store `GRAFITO_ENCRYPTION_KEY` somewhere safe, outside the server, such as a
password manager. Without it, the AI keys saved by users can't be read.

The internal services (Postgres, Elasticsearch, Redis, MinIO) only listen on
`127.0.0.1`. Publish only the app, preferably behind a reverse proxy with TLS.

## What holds data

| Service | Holds | Needs a backup? |
| --- | --- | --- |
| Postgres (`grafito_pg`) | Accounts, roles, every vault (notes, file metadata), sharing, versions, trash, API tokens, encrypted AI keys; file bytes too when there is no MinIO | **Yes**: it is the source of truth |
| MinIO (`grafito_s3`) | The bytes of uploaded files | **Yes** |
| Elasticsearch (`grafito_es`) | The search index | No: it is rebuilt from Postgres |
| Redis (`grafito_redis`) | Session deadlines | No: users only have to sign in again |

## Scheduled backups

Two services run on the same interval:

- **`backup`** runs `pg_dump` in custom format, writes the dump to
  `./backups/grafito-<UTC date>.dump`, and deletes dumps older than
  `BACKUP_KEEP_DAYS`.
- **`backup-files`** mirrors the MinIO bucket into `./backups/files`
  (`mc mirror`). It only adds files, never deletes them, so any retained
  database dump can still find the files it refers to. Prune it by hand if
  it grows too large.

| Variable | Default |
| --- | --- |
| `BACKUP_INTERVAL_SECONDS` | `86400` (daily) |
| `BACKUP_KEEP_DAYS` | `14` |

Check that it is working:

```bash
docker compose logs --tail 20 backup backup-files
ls -lh backups/ backups/files/
```

Copy `backups/` off the machine regularly, for example with rsync, restic or a
cloud bucket. A backup that lives only on the same disk doesn't protect you
from losing that disk.

To take a backup now:

```bash
docker compose exec backup sh -c 'pg_dump -Fc -f /backups/grafito-manual-$(date -u +%Y%m%d-%H%M%S).dump'
```

## Restore to a point in time

Restoring replaces the whole database with the chosen dump. Every change made
after it is lost.

```bash
# 1. Stop the app so nothing writes during the restore.
docker compose stop app

# 2. Restore the chosen dump.
docker compose exec -T backup pg_restore --clean --if-exists --no-owner -d grafito < backups/grafito-20261025-030000.dump

# 3. Put the files back (only needed if MinIO's volume was lost).
docker compose run --rm --entrypoint sh backup-files -c 'mc alias set local http://minio:9000 grafito "$S3_SECRET_KEY" && mc mirror --overwrite /backups/files local/grafito'

# 4. Start the app again.
docker compose start app
```

Browsers keep a local copy of each vault. After a restore, users who had
edited since the backup may push those newer local changes again when they
open Grafito. That is usually what you want. To discard them, they can clear
the site data in their browser before signing in.

Restoring one note doesn't require a full restore:

- **Trash:** deleted notes stay in the trash for 30 days.
- **History:** every note keeps its version history.

## Rotating secrets

### `GRAFITO_ENCRYPTION_KEY` (encrypts users' AI keys)

1. Generate a new key: `openssl rand -base64 48`.
2. In `.env`, move the current value to `GRAFITO_ENCRYPTION_KEY_PREVIOUS` and
   put the new one in `GRAFITO_ENCRYPTION_KEY`.
3. Run `docker compose up -d app`.
4. Each saved AI key is re-encrypted with the new key the next time its owner
   uses the chat. After a reasonable period (for example 30 days), remove
   `GRAFITO_ENCRYPTION_KEY_PREVIOUS`. Keys that weren't used in that period
   become unreadable, and their owners reconnect the provider in
   **Cuenta → Conexiones de IA**.

If the key is **lost**, nothing can recover the saved AI keys. Set a new key;
users then reconnect their providers. Notes and accounts are unaffected.

### `BETTER_AUTH_SECRET` (signs sessions)

Changing it invalidates every session, so everyone has to sign in again.
Nothing else is lost.

1. Generate a new secret: `openssl rand -base64 32`.
2. Put it in `.env` and run `docker compose up -d app`.

### Database and MinIO passwords

`POSTGRES_PASSWORD` is applied only when the volume is created. To change it on
an existing installation:

```bash
docker compose exec postgres psql -U grafito -c "alter user grafito password 'NEW_PASSWORD'"
```

Then update `.env` and run `docker compose up -d`.

## When something is down

| Symptom | Check | Fix |
| --- | --- | --- |
| The page doesn't load | `docker compose ps`, `docker compose logs --tail 100 app` | `docker compose up -d`. If `app` restarts in a loop with `ENOTFOUND postgres`, Postgres isn't healthy yet: `docker compose logs postgres`. |
| Sign-in fails for everyone | `docker compose logs app \| grep -i auth` | Make sure `BETTER_AUTH_URL` is the address people actually use, and that `BETTER_AUTH_SECRET` didn't change by accident. |
| Search returns nothing | Administración → Monitorización y logs → Fuentes → Comprobar | Start Elasticsearch. Search falls back to Postgres meanwhile. |
| Everyone is signed out | Redis was restarted or flushed | Nothing to fix: session deadlines are recreated on the next sign-in. |
| AI chat says the key can't be read | `GRAFITO_ENCRYPTION_KEY` changed without `GRAFITO_ENCRYPTION_KEY_PREVIOUS` | Put the old key back as `GRAFITO_ENCRYPTION_KEY_PREVIOUS` (see above), or have users reconnect. |
| Disk full | `docker system df`, `du -sh backups` | Lower `BACKUP_KEEP_DAYS`, move old dumps elsewhere, run `docker system prune`. |
| Data loss or corruption | — | Restore the latest good dump (see above). |

## Upgrading

```bash
git fetch --tags
git checkout v0.0.2          # or: git pull
docker compose up -d --build
```

Migrations run automatically when the app starts. Take a manual backup first
(see above).

# Saylo production backend

`backend/` is the FastAPI application used by the web app. `server/` is a legacy
reference implementation and is not started by these commands.

Use `backend/.env.local` for laptop-specific settings. If it does not exist,
copy `backend/.env.example` to that path; do not overwrite existing `.env` files.
Put the Supabase **PostgreSQL Session pooler URI** in `PITCH_DB_URL` in one of
the loaded env files if it is not already configured in the repository-root
`.env`. Do not put a Supabase publishable or secret API key in `PITCH_DB_URL`.
Settings take precedence in this order: shell environment, `backend/.env.local`,
`backend/.env`, then the repository-root `.env`.

Safe copy commands from the repository root:

```bash
# macOS/Linux
cp -n backend/.env.example backend/.env.local
```

```powershell
# Windows PowerShell
if (-not (Test-Path backend\.env.local)) { Copy-Item backend\.env.example backend\.env.local }
```

Then edit only `backend/.env.local` on your computer. Do not send or commit that file.

The example config uses Gemma through Ollama at
`http://localhost:11434`. Keep Ollama running and make sure the selected model is
available (`ollama list`). The current laptop model is `gemma4:e4b`.

Run from the repository root:

```bash
uvicorn backend.main:app --reload --port 8000
```

The API is available at `http://localhost:8000/docs`.

To transcribe with the GPU voice server instead of the stub, start it with `scripts/voice.ps1 -Tunnel`
and run the API with `PITCH_ASR=remote`, `PITCH_VOICE_URL` and `PITCH_VOICE_TOKEN` (see `voice/README.md`).

PowerShell on Windows uses the same launch command; no `source` or manual `.env`
loading is needed. The backend loads the env files automatically.

## Database and existing local data

With `PITCH_DB_URL` unset, the API uses `data/pitchcoach.db` (SQLite) and local
files. For team-shared use, every API machine must use the same Supabase Session
Pooler URI, `SUPABASE_URL`, private `SUPABASE_STORAGE_BUCKET`, and server-only
`SUPABASE_SERVICE_ROLE_KEY` in its ignored `backend/.env.local`. Create the
private bucket before starting the API. Shared mode stores uploads in that
bucket; the browser never receives the service-role key.

For the MVP, all teammates should point the web app at one shared FastAPI URL.
The analysis queue is in-process, so do not run multiple API/worker instances
against the shared database yet. Each developer can still use SQLite and a
local API for isolated work.

To bootstrap trusted administrators, set `PITCH_ADMIN_EMAILS` to a
comma-separated list of Google account emails in the API's private environment,
then restart the API. A listed account must complete Google sign-in before it
receives the admin role. Admins can access and manage all user content and
manage account roles/statuses through the admin endpoints in `/docs`; grant this
only to trusted team members. See `ROLE_ACCESS_UPDATE.md`.

Changing `PITCH_DB_URL` does not copy old SQLite data. Back up each teammate's
database and matching `data/sessions/`, then import one backup at a time with
`scripts/migrate_local_data.py`. Start the API once to initialize the shared
tables, then run a dry run and import from the repository root:

```powershell
python -m scripts.migrate_local_data --source-db C:\private-backups\member\data\pitchcoach.db --source-data-dir C:\private-backups\member\data --dry-run
python -m scripts.migrate_local_data --source-db C:\private-backups\member\data\pitchcoach.db --source-data-dir C:\private-backups\member\data
```

The importer preserves user IDs unless an explicitly approved `--map-user
SOURCE_ID=TARGET_ID` is supplied; conflicting project/session IDs stop the
import. It never changes source files. Keep backups until ownership, row counts,
audio playback, slide downloads, and API access have been verified. The current
checkout contains no teammate database or session files to import. See
`DATABASE.md` for private bucket setup and migration details.

## Environment file reference

The backend reads variables in this order: existing process environment,
`backend/.env.local`, `backend/.env`, then root `.env`; the first value wins.
Use `.env.local` for machine-specific credentials. Keep `.env`, `.env.local`,
database backups, and provider keys out of Git. The full variable reference and
the distinction between Supabase Database, Auth, and Storage are in `DATABASE.md`.
Only `backend/.env.example` and Markdown instructions should be shared through Git;
never use `git add -A` when local env files or unrelated team work are present.

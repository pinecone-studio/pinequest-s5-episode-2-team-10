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

With `PITCH_DB_URL` unset, the API uses `data/pitchcoach.db` (SQLite). To use the
shared Supabase Postgres database, set `PITCH_DB_URL` to the Session Pooler URI
in `backend/.env.local`. The API creates missing tables on startup; existing
SQLite rows are **not** copied automatically by changing this setting.

Uploads remain on local disk at `PITCH_DATA_DIR/sessions/<session_id>/`, even
when the database is Supabase. Keep that directory on persistent storage and
back it up with the matching SQLite database. Moving team data requires each
developer's database and upload folders, an agreed account/project ownership
mapping, and a reviewed migration script. Back up the sources and verify row
counts, ownership, files, and API reads before deleting any local copies.
See `DATABASE.md` for the migration checklist and current Supabase Storage status.

## Environment file reference

The backend reads variables in this order: existing process environment,
`backend/.env.local`, `backend/.env`, then root `.env`; the first value wins.
Use `.env.local` for machine-specific credentials. Keep `.env`, `.env.local`,
database backups, and provider keys out of Git. The full variable reference and
the distinction between Supabase Database, Auth, and Storage are in `DATABASE.md`.
Only `backend/.env.example` and Markdown instructions should be shared through Git;
never use `git add -A` when local env files or unrelated team work are present.

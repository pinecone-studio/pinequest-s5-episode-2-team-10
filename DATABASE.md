# Saylo Database Design

The database is **PostgreSQL on Supabase** for shared use and SQLite for isolated local development. Tables are defined with SQLModel in `backend/db.py` and created on server startup. With no `PITCH_DB_URL`, SQLite uses `data/pitchcoach.db` under the repository root. Every teammate must configure the same `PITCH_DB_URL` to share new database records. Existing SQLite rows are not copied automatically when the URL changes. There are no Alembic migrations yet.

## Tables

### `app_user`
An account. The browser keeps the access token.
- `id`: UUID primary key
- `token_hash`: SHA-256 of the access token (unique, indexed); the token itself is never stored
- `email`: optional lowercase unique email; `NULL` for accounts created before login existed
- `username`: optional unique normalized name (1–40 characters), chosen at registration or updated from Profile and usable instead of the email to sign in; `NULL` for Google, demo, and older accounts
- `password_hash`: PBKDF2-SHA256 (`pbkdf2_sha256$iterations$salt$digest`). The password itself is never stored
- `role`: `member` (default) or `admin`; assigned and enforced by the backend
- `is_active`: whether the account can authenticate (default `true`)
- `created_at`

### `access_token`
An additional authorized sign-in token for an account, including imported device tokens. Created on startup for existing databases; no need to drop tables.
- `token_hash`: SHA-256 of that computer's access token (primary key)
- `user_id` → `app_user.id` (indexed)
- `created_at`

### `project`
A folder for one pitch.
- `id`: UUID primary key
- `user_id` → `app_user.id` (indexed)
- `name`, `goal`, `audience`
- `idea`: the pitch idea in one or two sentences (default empty)
- `key_points`: JSON array of up to 6 main points the speech should get across (default empty)
- `point_slides`: JSON array mapping main points to slide numbers
- `figma_url`: optional Figma Slides/prototype URL
- `script`: current saved practice script
- `selected_audio_id`: the selected recording session, if one exists
- `planned_s`: planned length in seconds (30–900)
- `pitch_type`: `startup` or `academic`
- `created_at`, `updated_at` (updated on every new attempt or analysis)

### `session`
One attempt inside a project. Project details are copied in when it is analyzed, so history stays accurate.
- `id`: UUID primary key
- `project_id` → `project.id` (indexed)
- `title`, `goal`, `audience`, `idea`, `key_points`, `planned_s`, `pitch_type`: copied from the project
- `script`: planned script (optional)
- `audio_filename`: original recording filename
- `slides_filename`: original name of the uploaded deck
- `status`: `created`, `uploaded`, `processing`, `completed`, `failed`
- `stage`: `transcribing`, `measuring`, `slides`, `feedback`, `scoring` while processing
- `error`: user-readable failure message
- `feedback_backend`: `claude`, `gemma4-ft`, `gemma4-base`, or `rules`
- `created_at`

### `audio_asset`
- `session_id` → `session.id` (primary key)
- `path`: converted 16 kHz WAV used by the pipeline; a `storage://` object key in shared mode or a local path in SQLite mode
- `original_path`: the original upload, represented the same way
- `duration_s`, `format`

### `slide`
- `id` primary key; `session_id` → `session.id` (indexed)
- `number`, `text`, `notes`, `image_only`
- `numbers`, `key_terms`: JSON arrays used for slide matching

### `transcript`
- `session_id` → `session.id` (primary key)
- `text`, `sentences` (JSON: text, start, end), `words` (JSON: word, start, end), `language`

### `analysis_report`
- `session_id` → `session.id` (primary key; one report per attempt)
- `overall`, `content`, `delivery`, `slide_alignment`, `timing`: integers 0–100 or null when a category has no data
- `metrics`: JSON (duration, pace, pauses, pitch range, volume drop, fillers per 100 words)
- `slide_results`: JSON from slide matching
- `feedback`: validated LLM output, including `fillers` and `main_points`
- `extra`: JSON (categories used, delivery sub-scores, wording checks, notes, speech-to-text backend, prompt version)
- `backend`: which feedback model wrote it
- `created_at`

### Added columns

`project.idea`, `project.key_points`, `project.point_slides`, `project.figma_url`, `project.script`, `project.selected_audio_id`, `session.idea`, `session.key_points`, `session.audio_filename`, `app_user.email`, `app_user.password_hash`, `app_user.role`, and `app_user.is_active` are added when missing by `backend/db.py` (`ADDED_COLUMNS`), on SQLite and Postgres alike. Existing databases keep their data; no table recreation is needed. Existing users receive the safe defaults `member` and active. A unique index is added on `app_user.email` when the table does not already have one. Add later columns there too. Older rows keep a null email until someone registers.

## Relationships

- An `app_user` owns many projects; a project has many attempts (`session`).
- Each attempt has at most one audio asset, transcript, and report, and any number of slides.
- Deleting a project deletes its attempts, their rows, and their local or Storage files.

## Supabase setup

1. Create a Supabase project and copy the **session pooler** connection string (Project Settings → Database, port 5432). The transaction pooler (6543) also works.
2. Create a **private** Storage bucket named `saylo-session-files` (or choose another name and configure it consistently).
3. Put the Database URI in `PITCH_DB_URL` and set `SUPABASE_URL`, `SUPABASE_STORAGE_BUCKET`, and the server-only `SUPABASE_SERVICE_ROLE_KEY` in each API machine's private environment. Never put the service-role key in the web app, Git, or a shared `.env.example` value.
4. Start the API. It creates missing tables and turns on **row-level security** on each one, so Supabase's public REST API cannot read them. The API connects through the database URI. Existing Postgres tables are not dropped by startup.

The web app never talks to Supabase directly; all access goes through FastAPI, which checks ownership on every query. Signed-in member folders, scripts, and uploaded audio/slides are stored through the project/session API. A one-time browser migration uploads existing member data before removing its local copies; shared demo account data is excluded. For the MVP, teammates should point their web clients at the **same FastAPI URL** as well as the same database and bucket. The analysis queue is in-process; do not run multiple API/worker instances against the shared database until the queue is moved to a shared job system.

## Account roles

Accounts start as `member`, except the shared `demo@pitchcoach.local` account, which receives `admin` whenever anyone signs in with the demo button. Anyone who can reach the site can therefore use real admin APIs through this shared account. For other administrators, set the server-only `PITCH_ADMIN_EMAILS` environment variable to a comma-separated list of Google account emails. The backend verifies the email through Supabase Auth before applying the admin role; the browser cannot choose a role. Restart the API after changing this list. Allowlisted administrators stay protected from demotion through the API; remove an email from the list and then use the admin endpoint to change that account's stored role.

Admins can list accounts and update another account's role or active status with the FastAPI admin endpoints. Disabling an account revokes its current app tokens; re-enable it only when the user should sign in again. An admin cannot modify their own role/status, and the final active admin cannot be demoted or disabled. Admins can access all users' projects, attempts, reports, transcripts, audio, and slides, including modify/delete operations. Give admin access only to trusted people.

## Moving existing local data

Each developer's local SQLite database and uploaded files are separate. A normal team Git push does not include either: `data/` and local environment files are ignored. Also, pointing an API at Supabase does **not** import an existing `data/pitchcoach.db`.

The repository includes `scripts/migrate_local_data.py` for importing one backed-up SQLite database and its session files at a time. Before importing:

1. Choose one Supabase project as the shared destination and decide which team member owns each imported project. The `project.user_id` ownership relationship must be preserved or intentionally remapped; do not merge user records by email without agreement.
2. On every computer that has data, stop the API and make a private backup of `data/pitchcoach.db` (if present) and the corresponding `data/sessions/` directory. Never commit or upload these backups to Git.
3. Keep each person's data under the intended account. The importer preserves source user IDs by default. If a source account should be attached to an existing account, explicitly agree on that mapping and pass `--map-user SOURCE_ID=TARGET_ID`; the source access token is retained as an additional server-side token for that destination user.
4. Run the importer with `--dry-run` first. It checks source files, ownership mappings, and destination key conflicts without importing rows or files. The destination must be initialized and `PITCH_DB_URL` must point to the shared Supabase Postgres database.
5. Run the reviewed importer without `--dry-run`. It copies rows in dependency order and sends original audio, converted WAV, and slide decks to the private Storage bucket. The source DB and files are never changed.
6. Verify project/attempt counts, ownership, audio playback, slide download, and deletes through the API before removing any local copies. Import each teammate's database separately.
7. Keep source backups until the team has verified the shared database and files. Do not delete or overwrite source data as part of the import.

Example from the repository root, using local backup paths (do not commit these files):

```powershell
python -m scripts.migrate_local_data --source-db C:\private-backups\hosbat\pitchcoach.db --source-data-dir C:\private-backups\hosbat\data --dry-run
python -m scripts.migrate_local_data --source-db C:\private-backups\hosbat\pitchcoach.db --source-data-dir C:\private-backups\hosbat\data
```

If an email already belongs to a different shared user, the dry run reports the source user ID and the required explicit mapping. Add one or more `--map-user SOURCE_ID=TARGET_ID` options to both commands only after confirming the accounts represent the same person. A source account that is mapped to an existing account does not replace its password hash.

The current checkout has no source SQLite DB or session files in its `data/` directory, so no team data has yet been imported. Never run the importer on a live source DB; use private backups and retain them until validation is complete.

## File storage and Supabase Storage

In local SQLite mode, original audio, converted WAV audio, and uploaded slide decks are kept under `PITCH_DATA_DIR/sessions/<session_id>/`. In shared Postgres mode, the backend stores these files in the configured private Supabase Storage bucket and stores `storage://` object keys in the database. The API downloads files server-side for playback and analysis; the browser never receives the service-role key or direct public object URLs.

The backend checks project/attempt ownership before every file download and delete. The service-role key bypasses Storage policies, so it must remain server-side; private bucket access is exposed only through the authenticated FastAPI API.

Every shared API instance can now access the same objects. If the bucket or credentials are unavailable, shared-mode startup fails instead of silently saving new files only to local disk.

## Environment files

The backend loads environment values in this precedence order:

1. Variables already present in the process environment.
2. `backend/.env.local` (recommended for per-developer secrets).
3. `backend/.env`.
4. Repository-root `.env`.

The first value found wins. `.env.example` files are templates and are not loaded automatically. For a team, share only the templates and variable names; each person creates and fills their own ignored local file. Configure deployed API secrets in the hosting platform, not in Git.

Create a local backend env file without overwriting an existing one:

```bash
# macOS/Linux, from the repository root
cp -n backend/.env.example backend/.env.local
```

```powershell
# Windows PowerShell, from the repository root
if (-not (Test-Path backend\.env.local)) { Copy-Item backend\.env.example backend\.env.local }
```

Edit only `backend/.env.local` for machine-specific values. Uncomment `PITCH_DB_URL` and put the Supabase **Database Session Pooler URI** there to use shared Postgres. `SUPABASE_URL` is used for Storage and optional Google Auth; `SUPABASE_PUBLISHABLE_KEY` is only for optional Google Auth. Neither is the database URI. Do not paste actual passwords or keys into Markdown, templates, or Git.

| Variable | Purpose |
| --- | --- |
| `PITCH_DB_URL` | Supabase PostgreSQL connection URI; omit to use local SQLite. |
| `PITCH_DATA_DIR` | Local upload/database directory; default is repository `data/`. |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Supabase project URL (Storage and optional Google Auth) and publishable key (optional Google Auth). Neither is a database credential. |
| `SUPABASE_STORAGE_BUCKET` | Private bucket name; default setup uses `saylo-session-files`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase key for private Storage requests. Never expose or commit it. |
| `PITCH_ADMIN_EMAILS` | Comma-separated, server-only list of verified Google emails bootstrapped as admins. |
| `PITCH_CORS_ORIGINS` | Comma-separated web origins allowed by FastAPI. |
| `PITCH_RETENTION_DAYS` | Delete projects untouched for this many days; `0` keeps them. |
| `PITCH_DEFAULT_BACKEND` | Default feedback backend: `claude`, `gemma4-ft`, `gemma4-base`, or `rules`. |
| `ANTHROPIC_API_KEY`, `PITCH_CLAUDE_MODEL` | Claude provider key and optional model name. |
| `OLLAMA_URL`, `OLLAMA_TOKEN`, `PITCH_OLLAMA_MODEL_FT`, `PITCH_OLLAMA_MODEL_BASE`, `PITCH_OLLAMA_TIMEOUT_S`, `PITCH_OLLAMA_KEEP_ALIVE` | Ollama address/authentication and model/runtime settings. |
| `PITCH_ASR`, `PITCH_ASR_MODEL` | ASR selection (`duudlaga`, `whisper`, `remote`, or `stub`) and optional Whisper model. |
| `DUUDLAGA_API_KEY`, `DUUDLAGA_BASE_URL`, `DUUDLAGA_LANGUAGES` | Duudlaga speech-to-text configuration. |
| `PITCH_VOICE_URL`, `PITCH_VOICE_TOKEN`, `PITCH_VOICE_TIMEOUT_S` | Remote GPU voice server configuration when `PITCH_ASR=remote`. |
| `PITCH_EMBEDDINGS`, `PITCH_EMBEDDING_MODEL` | Slide-matching embeddings (`e5` or `none`) and optional model. |

Only set credentials for providers you use. A Postgres/shared setup requires the private Storage bucket and the three Storage settings above.

## Privacy and retention

- Projects are kept until the user deletes them (`PITCH_RETENTION_DAYS=0`). Setting a number of days deletes projects untouched for that long at startup.
- In local SQLite mode, audio and slides live on disk under `data/sessions/`; in shared Postgres mode, uploaded audio and slide files live in private Supabase Storage. Scripts and analysis records remain in Postgres.
- Access tokens are stored only as hashes.

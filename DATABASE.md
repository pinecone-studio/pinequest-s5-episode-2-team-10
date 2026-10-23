# Saylo Database Design

The database is **PostgreSQL on Supabase** in hosted setups and SQLite for local development. Tables are defined with SQLModel in `backend/db.py` and created on server startup. There are no migrations yet: after a schema change, drop the tables (or delete `data/pitchcoach.db`) and restart.

## Tables

### `app_user`
An account. The browser keeps the access token.
- `id`: UUID primary key
- `token_hash`: SHA-256 of the access token (unique, indexed); the token itself is never stored
- `email`: lowercase, unique, empty for accounts created before login existed
- `password_hash`: PBKDF2-SHA256 (`pbkdf2_sha256$iterations$salt$digest`). The password itself is never stored
- `created_at`

### `project`
A folder for one pitch.
- `id`: UUID primary key
- `user_id` → `app_user.id` (indexed)
- `name`, `goal`, `audience`
- `idea`: the pitch idea in one or two sentences (default empty)
- `key_points`: JSON array of up to 6 main points the speech should get across (default empty)
- `planned_s`: planned length in seconds (30–900)
- `pitch_type`: `startup` or `academic`
- `created_at`, `updated_at` (updated on every new attempt or analysis)

### `session`
One attempt inside a project. Project details are copied in when it is analyzed, so history stays accurate.
- `id`: UUID primary key
- `project_id` → `project.id` (indexed)
- `title`, `goal`, `audience`, `idea`, `key_points`, `planned_s`, `pitch_type`: copied from the project
- `script`: planned script (optional)
- `slides_filename`: original name of the uploaded deck
- `status`: `created`, `uploaded`, `processing`, `completed`, `failed`
- `stage`: `transcribing`, `measuring`, `slides`, `feedback`, `scoring` while processing
- `error`: user-readable failure message
- `feedback_backend`: `claude`, `gemma4-ft`, `gemma4-base`, or `rules`
- `created_at`

### `audio_asset`
- `session_id` → `session.id` (primary key)
- `path`: converted 16 kHz WAV used by the pipeline
- `original_path`: the file as uploaded, for playback
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

`project.idea`, `project.key_points`, `session.idea`, `session.key_points`, `app_user.email` and `app_user.password_hash` were added after the first release. `backend/db.py` adds them on startup when they are missing (`ADDED_COLUMNS`), on SQLite and Postgres alike, so existing databases keep their data. A unique index is added on `app_user.email` when the table does not already have one. Add later columns there too. Older rows keep a null email until someone registers.

## Relationships

- An `app_user` owns many projects; a project has many attempts (`session`).
- Each attempt has at most one audio asset, transcript, and report, and any number of slides.
- Deleting a project deletes its attempts, their rows, and their files on disk.

## Supabase setup

1. Create a Supabase project and copy the **session pooler** connection string (Project Settings → Database, port 5432). The transaction pooler (6543) also works.
2. Set `PITCH_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` on the API server.
3. Start the API. It creates the tables and turns on **row-level security** on each one, so Supabase's public REST API (anon key) cannot read them. The API connects as the table owner and is not affected.

The web app never talks to Supabase directly; all access goes through FastAPI, which checks ownership on every query.

## Privacy and retention

- Projects are kept until the user deletes them (`PITCH_RETENTION_DAYS=0`). Setting a number of days deletes projects untouched for that long at startup.
- Audio, slides, and scripts live on the API server's disk under `data/sessions/`, not in Supabase. Moving them to private Supabase Storage is planned.
- Access tokens are stored only as hashes.

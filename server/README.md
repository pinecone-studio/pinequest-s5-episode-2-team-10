# AI Pitch Coach: API server

FastAPI service from TDD v2. It stores sessions in SQLite with files under `data/sessions/<id>/`, and runs one analysis job at a time in a background worker, because the GPU only fits one.

## Run

```bash
python -m venv .venv && source .venv/bin/activate     # Python 3.10+
pip install -r requirements.txt                       # API + light pipeline steps
pip install -r requirements-ml.txt                    # demo machine only: BuzzASR, e5 embeddings
cp .env.example .env && set -a && source .env && set +a
uvicorn server.main:app --reload --port 8000
```

Interactive docs: http://localhost:8000/docs

**Without a GPU:** `PITCH_ASR=stub PITCH_EMBEDDINGS=none` runs everything with sample transcript text, and the `rules` feedback backend needs no model or API key. Reports say when stub data was used (`notes`).

ffmpeg is used from PATH, or from the `imageio-ffmpeg` package if it isn't installed.

## Endpoints (`/api/v1`)

There are no logins yet. The browser calls `POST /users` once, keeps the token, and sends it as `X-Access-Token` on every request. Projects (folders) belong to that user, and every analysis is an **attempt** (a session) inside a project. Anything owned by another user returns 404.

**Users and projects**

| Method and path | Does |
| --- | --- |
| `POST /users` | Create an anonymous user. Returns `{id, access_token}` |
| `GET /projects` | The user's projects, most recently used first, with `attempt_count` and `latest_overall` |
| `POST /projects` | Body: `name, goal, audience, planned_s (30–900), pitch_type (startup/academic)`, all optional |
| `GET /projects/{id}` | Project details, `attempts` (newest first) and `current` (slides and script the next attempt will reuse) |
| `PATCH /projects/{id}` | Update any detail |
| `DELETE /projects/{id}` | Delete the project, its attempts and files (409 while one is running) |
| `POST /projects/{id}/sessions` | New attempt. Copies the project details, plus slides and script from the latest attempt unless `{"copy_inputs": false}` |

**Attempt inputs and uploads**

| Method and path | Does |
| --- | --- |
| `POST /sessions/{id}/audio` | Multipart `file`. WAV/MP3/M4A/WebM/OGG, 25 MB, 5 min. Returns `{duration_s, format}` |
| `POST /sessions/{id}/slides` | Multipart `file`. PDF/PPTX, 20 MB, 40 slides. Returns `{slide_count, image_only, filename}` |
| `DELETE /sessions/{id}/slides` | Remove slides from this attempt |
| `PUT /sessions/{id}/script` | Body `{text}`: what the speaker planned to say. Sent to the feedback model next to the transcript |
| `GET /sessions/{id}/audio` | The uploaded recording, for playback |
| `GET /sessions/{id}/slides` | Extracted text per slide and the file name |
| `GET /sessions/{id}/slides/file` | The uploaded deck |
| `GET /sessions/{id}/script` | The script |

**Analysis**

| Method and path | Does |
| --- | --- |
| `POST /sessions/{id}/analyze` | Body `{feedback_backend?: claude, gemma4-ft, gemma4-base, rules}`. Uses the project's current details. 202, or 409 without audio |
| `GET /sessions/{id}/status` | `{status, stage, queue_position, error}` |
| `GET /sessions/{id}/report` | Scores, metrics, slide results, feedback, transcript, script. 409 until completed |
| `GET /sessions/compare?a=&b=` | Before and after for two of the user's attempts |
| `DELETE /sessions/{id}` | Delete one attempt |
| `GET /health` | Configured ASR, embeddings and default model |

**Errors** are always `{"code", "message"}`, and the message is written to show in the UI as is. `status` goes `created → uploaded → processing → completed | failed`; while processing, `stage` is `transcribing, measuring, slides, feedback, scoring`.

**Database changes:** there are no migrations yet. After pulling this version, delete `data/pitchcoach.db` (or drop the Supabase tables) so the new tables are created.

## Pipeline (`pipeline/`)

| Module | Does |
| --- | --- |
| `audio.py` | ffmpeg conversion, duration |
| `asr.py` | BuzzASR word timestamps (or `stub`); unloads before feedback to free the GPU |
| `segments.py` | Sentences split at punctuation or pauses over 0.7 s |
| `metrics.py` | Pace, long pauses, pitch range (parselmouth), volume drop at the end |
| `text_checks.py` | Fillers from `fillers_mn.txt`, repeats, sentence length |
| `slides.py` | Text, numbers and key terms per slide; under 5 words = image-only |
| `alignment.py` | e5 (or key-word) similarity, monotonic DP, coverage, number mismatch candidates |
| `feedback.py` | Schema v2 via Claude / Ollama / rules, with the same prompt (`prompts/feedback_v2.md`) and JSON schema; output checked afterwards |
| `scoring.py` | 0.35 C + 0.30 D + 0.25 S + 0.10 T, missing categories reweighted; all thresholds in one table |
| `run.py` | Runs the steps in order and reports each stage |

The thresholds in `scoring.py` and `alignment.py` are first guesses. Tune them on our own clips and decks.

## Using Supabase (Postgres)

Set `PITCH_DB_URL` to the Supabase connection string (Project Settings → Database). The session pooler (port 5432) is the safest choice; the transaction pooler (6543) also works. Tables are created on startup, with row-level security turned on so Supabase's public REST API can't read them.

Uploaded files are still stored on the server's disk under `PITCH_DATA_DIR`, not in Supabase Storage. That's fine while the API runs on the demo laptop.

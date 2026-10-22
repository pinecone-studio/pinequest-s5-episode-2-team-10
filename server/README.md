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

| Method and path | Does | Errors |
| --- | --- | --- |
| `POST /sessions` | Body: `title, goal, audience, planned_s (30–900), pitch_type (startup/academic), group_id?`. Returns `{id, access_token}` | 422 |
| `POST /sessions/{id}/audio` | Multipart `file`. WAV/MP3/M4A/WebM/OGG, 25 MB, 5 min. Converted to 16 kHz mono WAV. Returns `{duration_s, format}` | 400, 409, 413, 415 |
| `POST /sessions/{id}/slides` | Multipart `file`. PDF/PPTX, 20 MB, 40 slides. Text extracted at once. Returns `{slide_count, image_only: [n]}` | 400, 409, 413, 415 |
| `POST /sessions/{id}/analyze` | Body: `{feedback_backend?: claude, gemma4-ft, gemma4-base, rules}`. Returns 202 `{status, queue_position}` | 409 no audio / busy, 422 |
| `GET /sessions/{id}/status` | `{status, stage, queue_position, error}` | |
| `GET /sessions/{id}/report` | Scores, metrics, slide results, feedback, transcript | 409 not ready |
| `GET /sessions/compare?a=&b=` | Before/after changes. Tokens in `X-Access-Token-A` and `X-Access-Token-B` | 404, 409 |
| `DELETE /sessions/{id}` | Deletes rows and files | 409 while running |
| `GET /health` | Which ASR, embeddings and default backend are configured | |

**Auth:** send the session's token as `X-Access-Token`. A missing or wrong token gets 404.

**Errors:** every error is `{"code", "message"}`, and the message is written to show in the UI as is.

**Status values:** `created → uploaded → processing → completed | failed`. While processing, `stage` is `transcribing, measuring, slides, feedback, scoring`. `queue_position` is 0 when running and n when n jobs are ahead.

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

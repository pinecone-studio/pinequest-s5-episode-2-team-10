# Saylo Technical Design

## 1. Architecture

```text
Browser (Next.js app, web/)
  |  X-Access-Token (email account)
  v
FastAPI (backend/)
  |-- Validate uploads, ownership, limits
  |-- Save files under data/sessions/<attempt id>/
  |-- Store projects, attempts, results in Supabase Postgres (SQLite locally)
  |-- Queue the attempt
  v
Background worker (one job at a time; the GPU fits one)
  |-- ffmpeg: convert to 16 kHz mono WAV
  |-- Speech-to-text: BuzzASR (Whisper large-v3), word timestamps
  |-- Sentences, voice metrics, wording checks, filler candidates
  |-- Slide text extraction and speech-to-slide matching
  |-- LLM feedback: Claude or Gemma 4 (Ollama), JSON schema enforced
  |-- Verify model output against the transcript
  |-- Score in code
  v
Supabase Postgres --> web app polls status and shows the report
```

Everything runs in one FastAPI process. Analysis takes 20 to 60 seconds, so it runs in a background worker and the browser polls `GET /sessions/{id}/status` every 2 seconds.

## 2. Implementation choices

| Area | Choice | Notes |
| --- | --- | --- |
| Frontend | Next.js 16 + React 19 + TypeScript + Tailwind CSS 4 | `web/`; demo mode without a backend |
| Backend | FastAPI (Python) | `backend/main.py`; the only backend, no Next.js API routes |
| ORM | SQLModel (SQLAlchemy) | Tables created on startup; no migrations yet |
| Database | Supabase Postgres in hosted setups, SQLite locally | Set `PITCH_DB_URL`; see `DATABASE.md` |
| File storage | Server disk (`PITCH_DATA_DIR`) | Move to Supabase Storage when the API leaves the demo laptop |
| Identity | Anonymous user token, hashed in the database | Supabase Auth or similar can replace it later |
| Validation | Pydantic for API input and LLM output | TypeScript types mirror the API in `web/src/lib/types.ts` |
| Speech-to-text | BuzzASR/mongolian via transformers | Needs the GPU machine; `PITCH_ASR=stub` for testing |
| LLM | Claude (`claude-opus-5-5`) or Gemma 4 E4B through Ollama | Chosen per analysis; `rules` runs without a model |
| Secrets | Environment variables (`.env`, hosting platform) | Names only in `.env.example` |

## 3. Processing states

An attempt (`session` table) moves through:

- `created`: attempt exists, no audio yet
- `uploaded`: audio converted and stored
- `processing`: queued or running; `stage` is `transcribing`, `measuring`, `slides`, `feedback`, or `scoring`, and `queue_position` says how many jobs are ahead
- `completed`: report stored
- `failed`: `error` holds a message safe to show the user

Status is persisted, so the UI recovers after a refresh. Attempts still `processing` when the server restarts are queued again.

## 4. Key design rules

- Provider API keys stay on the server; the browser only talks to FastAPI.
- Uploads are checked for extension, size, duration, and whether ffmpeg can decode them.
- Every project and attempt query checks ownership; anything owned by another user returns 404.
- LLM output must pass the Pydantic schema, then code checks it: evidence and filler occurrences must exist in the transcript, timestamps and slide numbers must come from the input, and invented items are dropped.
- Every number in the report comes from code; the model judges content and writes advice.
- Errors are returned as `{"code", "message"}` with a plain-language message.
- Logs record status changes and failures, not audio or full transcripts.

## 5. Reliability and cost

- Limits: audio 25 MB and 5 minutes; slides 20 MB and 40 slides.
- One worker runs one job at a time; the speech model is unloaded before the LLM runs to fit an 8 GB GPU.
- Claude calls use server-side refusal fallback and fail with a readable message on rate limits or outages; Ollama calls have a configurable timeout.
- A failed attempt keeps its uploads; the user can start a new attempt.
- Each report stores which model wrote it and the prompt version.

## 6. Deployment

- **Web app:** Vercel (or any Next.js host) with `NEXT_PUBLIC_API_URL` pointing at the API.
- **API and worker:** the RTX 4060 laptop, exposed with a tunnel (Cloudflare Tunnel or ngrok), with `PITCH_CORS_ORIGINS` set to the web app's URL. A CPU-only host is too slow for Mongolian Whisper.
- **Database:** Supabase Postgres through `PITCH_DB_URL` (session pooler, port 5432).
- **Files:** on the laptop's disk for now.

## 7. Open decisions

- Whether pace, pauses, pitch range, and volume drop are shown as scores, given the transcript-first MVP boundary.
- When to move uploads to Supabase Storage and add database migrations (Alembic).
- Whether to add logins (for example Supabase Auth) so projects follow a user across devices.

# Instructions for AI Coding Assistants

## Project context

Saylo is a speaking-practice MVP. A user keeps one project per pitch, uploads audio (and optionally slides and a script), the app transcribes speech, analyzes it, and displays evidence-based feedback.

The code has three parts: `web/` (Next.js), `backend/` (FastAPI), and `pipeline/` (Python analysis). The database is Supabase Postgres (SQLite locally).

Read `README.md`, `PRD.md`, `TECHNICAL_DESIGN.md`, `AI_PIPELINE.md`, `API.md`, and `DATABASE.md` before making broad changes.

## Non-negotiable product boundaries

- The MVP is transcript-first. The backend also measures pace, pauses, pitch range, and volume drop; whether those are shown as scores is an open product decision, so don't add new voice claims.
- Do not claim to measure confidence, emotion, facial expressions, intonation, or vocal quality unless a separately validated feature is implemented.
- Do not fabricate transcript evidence.
- Rewrites must preserve the speaker's intended meaning.
- Treat Mongolian ASR quality as something to measure, not assume.

## Coding rules

- Web app: TypeScript, with API shapes in `web/src/lib/types.ts`. Server and pipeline: Python with type hints.
- Validate API input and model output with Pydantic on the server; check model output against the transcript before storing it (see `pipeline/feedback.py`).
- Keep provider calls on the server. Never expose API keys in client bundles.
- Keep secrets in environment variables and update `.env.example` with variable names only (the database URL holds the Supabase password).
- Follow the existing project structure and conventions; do not create duplicate architectures.
- Prefer small reusable components and focused functions.
- Handle loading, empty, success, and failure states in the UI.
- Use accessible labels, keyboard navigation, and responsive layouts.
- Add tests for scoring, validation, ownership checks, and failure cases when those areas change (`tests/`, run with `python -m pytest tests`).
- Do not log raw audio, credentials, or full transcripts unless explicitly required for a controlled debugging session.

## Working process

1. Inspect the existing code before editing.
2. State the files and behavior that need to change.
3. Implement the smallest coherent change.
4. Run relevant checks: `python -m pytest tests`; in `web/`, `npm run lint`, `npx tsc --noEmit`, and `npm run build`.
5. Report what changed and any checks that could not be run.
6. Do not claim a command or test passed unless it actually ran successfully.

## Architecture rules

- FastAPI in `backend/` is the only backend. Do not add Next.js Route Handlers or a separate Node API.
- Keep AI provider logic in `pipeline/` (Claude via the Anthropic SDK, Gemma via Ollama), called only from the worker.
- Keep scoring rules deterministic and documented where practical.
- Persist processing status (`session.status` and `stage`) and handle provider timeouts and failures with readable messages.
- Use SQLModel for database access; the web app never talks to Supabase directly. Tables have row-level security turned on.
- Enforce project and attempt ownership on every protected operation (404 for other users' data).
- Do not silently change API contracts or database schema without updating `API.md`, `DATABASE.md`, and `web/src/lib/types.ts`. There are no migrations yet; say so when a change needs the tables recreated.

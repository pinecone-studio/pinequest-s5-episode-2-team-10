# Saylo

Saylo is an AI-assisted speaking practice tool. A user keeps one project per pitch, uploads slides and a short Mongolian recording, and gets a transcript, a coaching score, evidence-based feedback (including filler words), and concrete next steps. Every attempt is saved so progress can be compared.

## MVP goals

- Create projects (folders) and practice the same pitch over several attempts.
- Upload or record audio, optionally with slides (PDF/PPTX) and a planned script.
- Transcribe Mongolian speech with a speech-to-text model selected through testing.
- Analyze the transcript for filler words, repetition, unclear phrasing, and organization.
- Return a structured score, examples from the transcript, and practical recommendations.
- Let users revisit and delete their projects, attempts, and uploads.

## MVP boundaries

Feedback is primarily **transcript-based**. Do not claim to evaluate confidence, emotion, or facial expression. The current backend also measures pace, pauses, pitch range, and volume drop from the audio; whether to show those as scores is an open product decision (see `AGENTS.md`).

## Current stack

| Part | Choice | Where |
| --- | --- | --- |
| Web app | Next.js 16, React 19, TypeScript, Tailwind CSS 4 | `web/` |
| API | FastAPI (Python 3.10+), one background worker | `backend/` |
| Analysis pipeline | Python modules: ASR, metrics, slides, fillers, LLM feedback, scoring | `pipeline/` |
| Database | PostgreSQL on **Supabase** (SQLite for local development), via SQLModel | `backend/db.py` |
| File storage | Local disk with SQLite; private Supabase Storage with shared Postgres | `backend/storage.py` |
| Speech-to-text | BuzzASR/mongolian (Whisper large-v3) on the GPU machine; `stub` mode for testing | `pipeline/asr.py` |
| LLM analysis | Claude (Anthropic API) or Gemma 4 through Ollama (base and fine-tuned) | `pipeline/feedback.py` |
| Validation | Pydantic on the server; shared TypeScript types in the web app | `pipeline/feedback.py`, `web/src/lib/types.ts` |
| Identity | Email/password or Supabase Google sign-in; backend-enforced `member`/`admin` roles | `backend/main.py` |

## Core flow

1. The user registers or signs in. The browser keeps the access token and creates a project.
2. Each analysis is an attempt: slides and script are reused from the previous attempt, a new recording is uploaded.
3. The server validates and converts the audio, and queues the attempt.
4. The worker transcribes, measures, matches speech to slides, asks the LLM for feedback, verifies it, and scores it in code.
5. The web app polls the status and shows the score, filler words, recommendations, transcript, and uploads.

## Getting started

```bash
# API (from the repo root)
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # add requirements-ml.txt on the GPU machine
# If backend/.env.local does not exist, copy backend/.env.example to that path.
# For team-shared use, set PITCH_DB_URL, SUPABASE_URL, SUPABASE_STORAGE_BUCKET,
# and the server-only SUPABASE_SERVICE_ROLE_KEY in a loaded env file.
uvicorn backend.main:app --reload --port 8000

# Web app
cd web && npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

Without a GPU, set `PITCH_ASR=stub PITCH_EMBEDDINGS=none`. Without `NEXT_PUBLIC_API_URL`, the web app runs in demo mode with sample data. To try only the AI analysis on a transcript, see `TESTING.md`.

Do not commit `.env` or real API keys.
The backend automatically loads `backend/.env.local`, `backend/.env`, then the
repository-root `.env`; shell environment variables take precedence. The backend
example selects Gemma through local Ollama; keep Ollama running and ensure the
configured model is available. Do not overwrite existing `.env` files.

## Subscription and QPay

New accounts get a 7-day free trial; each QPay payment then adds 30 days. Nobody is blocked
until `PITCH_BILLING_ENFORCED=true`, so leave it unset for local work. Rules and endpoints are in
`API.md` ("Subscription"); variables are listed in `DATABASE.md` ("Environment files").

To try payments with the QPay sandbox:

1. Get sandbox credentials from QPay and put them in `backend/.env.local`:
   `QPAY_CLIENT_ID`, `QPAY_CLIENT_SECRET`, `QPAY_INVOICE_CODE` (`QPAY_BASE_URL` defaults to the sandbox).
2. Set a price, e.g. `PITCH_SUBSCRIPTION_PRICE_MNT=9900`, and restart the API.
3. Open **Billing** from the account menu, choose **Renew plan**, and pay the sandbox QR code.
   The page checks QPay every 3 seconds. QPay's callback also reaches the API when
   `PITCH_PUBLIC_API_URL` is a public address (for example a tunnel to port 8000); without it the
   page's checks are enough.
4. For production, use `QPAY_BASE_URL=https://merchant.qpay.mn`, the live credentials, the real
   public API address, and turn on `PITCH_BILLING_ENFORCED=true` only after a sandbox payment works.

An admin can add days by hand with `PATCH /admin/users/{id}` and `{"grant_days": 30}`.

## Project documents

- `PRD.md`: product scope and user stories
- `TECHNICAL_DESIGN.md`: architecture and implementation decisions
- `AI_PIPELINE.md`: transcription and analysis behavior
- `DATABASE.md`: tables and Supabase setup
- `API.md`: endpoint contracts
- `AGENTS.md`: instructions for AI coding assistants
- `TASKS.md`: MVP work breakdown
- `TESTING.md`: tests, how to try the analysis, and acceptance criteria
- `backend/README.md`, `web/README.md`: setup details for each part

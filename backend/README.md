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

The example config uses `gemma4-base` through Ollama at
`http://localhost:11434`. Keep Ollama running and make sure the selected model is
available (`ollama list`). The current laptop model is `gemma4:e4b`.

Run from the repository root:

```bash
uvicorn backend.main:app --reload --port 8000
```

The API is available at `http://localhost:8000/docs`.

PowerShell on Windows uses the same launch command; no `source` or manual `.env`
loading is needed. The backend loads the env files automatically.

To transcribe with the GPU voice server instead of the stub, start it with `scripts/voice.ps1 -Tunnel`
and run the API with `PITCH_ASR=remote`, `PITCH_VOICE_URL` and `PITCH_VOICE_TOKEN` (see `voice/README.md`).

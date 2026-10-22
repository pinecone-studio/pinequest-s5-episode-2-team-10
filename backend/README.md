# Saylo production backend

Run from the repository root:

```bash
source .venv/bin/activate
set -a && source .env && set +a
PITCH_ASR=stub PITCH_EMBEDDINGS=none uvicorn backend.main:app --reload --port 8000
```

The API is available at `http://localhost:8000/docs`.

To transcribe with the GPU voice server instead of the stub, start it with `scripts/voice.ps1 -Tunnel`
and run the API with `PITCH_ASR=remote`, `PITCH_VOICE_URL` and `PITCH_VOICE_TOKEN` (see `voice/README.md`).

`server/` remains temporarily as the reference implementation while the team verifies
the migration. Do not delete it until the backend API and pipeline have been tested.

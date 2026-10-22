# Saylo production backend

Run from the repository root:

```bash
source .venv/bin/activate
set -a && source .env && set +a
PITCH_ASR=stub PITCH_EMBEDDINGS=none uvicorn backend.main:app --reload --port 8000
```

The API is available at `http://localhost:8000/docs`.

`server/` remains temporarily as the reference implementation while the team verifies
the migration. Do not delete it until the backend API and pipeline have been tested.

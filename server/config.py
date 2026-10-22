"""Server settings, read from environment variables."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DATA_DIR = Path(os.environ.get("PITCH_DATA_DIR", ROOT / "data")).resolve()
SESSIONS_DIR = DATA_DIR / "sessions"
DB_URL = os.environ.get("PITCH_DB_URL", f"sqlite:///{DATA_DIR / 'pitchcoach.db'}")

CORS_ORIGINS = [o.strip() for o in os.environ.get("PITCH_CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
DEFAULT_BACKEND = os.environ.get("PITCH_DEFAULT_BACKEND", "claude")
RETENTION_DAYS = int(os.environ.get("PITCH_RETENTION_DAYS", "7"))

# Upload limits (TDD API table)
AUDIO_MAX_BYTES = 25 * 1024 * 1024
AUDIO_MAX_S = 5 * 60
AUDIO_FORMATS = {".wav", ".mp3", ".m4a", ".webm", ".ogg"}
SLIDES_MAX_BYTES = 20 * 1024 * 1024
SLIDES_MAX_COUNT = 40
SLIDES_FORMATS = {".pdf", ".pptx"}

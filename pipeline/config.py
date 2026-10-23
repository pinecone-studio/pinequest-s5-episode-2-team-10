"""Pipeline settings, read from environment variables."""

import os


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


# Speech to text: "duudlaga" calls api.duudlaga.dev (needs DUUDLAGA_API_KEY),
# "whisper" runs BuzzASR (needs requirements-ml.txt),
# "remote" sends audio to the local voice server (voice/server.py), e.g. through a Cloudflare tunnel,
# "stub" returns sample text so the API can be tested without a GPU.
ASR_BACKEND = _env("PITCH_ASR", "duudlaga")
ASR_MODEL = _env("PITCH_ASR_MODEL", "BuzzASR/mongolian")
DUUDLAGA_API_KEY = _env("DUUDLAGA_API_KEY", "")
DUUDLAGA_BASE_URL = _env("DUUDLAGA_BASE_URL", "https://api.duudlaga.dev").rstrip("/")
DUUDLAGA_LANGUAGES = _env("DUUDLAGA_LANGUAGES", "mn-MN,en-US")

# Voice server (PITCH_ASR=remote). The token must match VOICE_SERVER_TOKEN on the voice machine.
VOICE_URL = _env("PITCH_VOICE_URL", "http://localhost:8001").rstrip("/")
VOICE_TOKEN = _env("PITCH_VOICE_TOKEN", "")
VOICE_TIMEOUT_S = float(_env("PITCH_VOICE_TIMEOUT_S", "300"))

# Slide alignment: "e5" uses multilingual-e5-small on CPU, "none" uses key-term overlap only.
EMBEDDINGS = _env("PITCH_EMBEDDINGS", "e5")
EMBEDDING_MODEL = _env("PITCH_EMBEDDING_MODEL", "intfloat/multilingual-e5-small")

# Feedback models.
CLAUDE_MODEL = _env("PITCH_CLAUDE_MODEL", "claude-opus-5-5")
OLLAMA_URL = _env("OLLAMA_URL", "http://localhost:11434")
# Set when OLLAMA_URL is the voice server's /v1/ollama route on another machine (its VOICE_SERVER_TOKEN).
OLLAMA_TOKEN = _env("OLLAMA_TOKEN", "")
OLLAMA_MODEL_FT = _env("PITCH_OLLAMA_MODEL_FT", "pitchcoach-gemma4")
OLLAMA_MODEL_BASE = _env("PITCH_OLLAMA_MODEL_BASE", "gemma4:e4b")
OLLAMA_TIMEOUT_S = float(_env("PITCH_OLLAMA_TIMEOUT_S", "240"))
# How long Ollama keeps the model loaded after a request: -1 = until Ollama stops, or e.g. "10m".
_keep = _env("PITCH_OLLAMA_KEEP_ALIVE", "-1")
OLLAMA_KEEP_ALIVE = int(_keep) if _keep.lstrip("-").isdigit() else _keep

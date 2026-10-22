"""Pipeline settings, read from environment variables."""

import os


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


# Speech to text: "whisper" runs BuzzASR (needs requirements-ml.txt),
# "stub" returns sample text so the API can be tested without a GPU.
ASR_BACKEND = _env("PITCH_ASR", "whisper")
ASR_MODEL = _env("PITCH_ASR_MODEL", "BuzzASR/mongolian")

# Slide alignment: "e5" uses multilingual-e5-small on CPU, "none" uses key-term overlap only.
EMBEDDINGS = _env("PITCH_EMBEDDINGS", "e5")
EMBEDDING_MODEL = _env("PITCH_EMBEDDING_MODEL", "intfloat/multilingual-e5-small")

# Feedback models.
CLAUDE_MODEL = _env("PITCH_CLAUDE_MODEL", "claude-opus-5-5")
OLLAMA_URL = _env("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL_FT = _env("PITCH_OLLAMA_MODEL_FT", "pitchcoach-gemma4")
OLLAMA_MODEL_BASE = _env("PITCH_OLLAMA_MODEL_BASE", "gemma4:e4b")
OLLAMA_TIMEOUT_S = float(_env("PITCH_OLLAMA_TIMEOUT_S", "240"))

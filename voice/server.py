"""Local voice server: runs BuzzASR (Mongolian Whisper) on this machine's GPU.

The API calls it with PITCH_ASR=remote. It can sit behind a Cloudflare tunnel, so every
transcription request needs `Authorization: Bearer <VOICE_SERVER_TOKEN>`.

Run from the repository root:
    uvicorn voice.server:app --port 8001
"""

import os
import secrets
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from pipeline import asr, config as pipeline_config
from pipeline.audio import AudioError, to_wav16k

TOKEN = os.environ.get("VOICE_SERVER_TOKEN", "").strip()
PRELOAD = os.environ.get("VOICE_PRELOAD", "1").strip() != "0"
MAX_BYTES = 25 * 1024 * 1024  # same limits as the API's audio upload
MAX_SECONDS = 5 * 60 + 5

# One GPU, one model: transcribe one file at a time.
_gpu_lock = threading.Lock()


class VoiceError(HTTPException):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(status_code=status, detail={"code": code, "message": message})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not TOKEN:
        raise RuntimeError("Set VOICE_SERVER_TOKEN before starting the voice server.")
    if PRELOAD:
        asr._load()  # load the model now so the first request isn't slow
    yield


app = FastAPI(title="Saylo voice server", lifespan=lifespan)


@app.exception_handler(HTTPException)
async def _error(_req: Request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
    return JSONResponse(detail, status_code=exc.status_code)


def require_token(authorization: str = Header(default="")) -> None:
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(value.strip(), TOKEN):
        raise VoiceError(401, "unauthorized", "Missing or wrong voice server token.")


@app.get("/health")
def health():
    try:
        import torch

        cuda = torch.cuda.is_available()
        device = torch.cuda.get_device_name(0) if cuda else "cpu"
    except ImportError:
        cuda, device = False, "torch not installed"
    return {
        "ok": True,
        "model": pipeline_config.ASR_MODEL,
        "model_loaded": asr.is_loaded(),
        "cuda": cuda,
        "device": device,
        "busy": _gpu_lock.locked(),
    }


@app.post("/v1/transcribe", dependencies=[Depends(require_token)])
def transcribe(file: UploadFile):
    with tempfile.TemporaryDirectory(prefix="voice-") as tmp:
        src = Path(tmp) / f"upload{Path(file.filename or '').suffix.lower() or '.bin'}"
        size = 0
        with src.open("wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise VoiceError(413, "too_large", "Audio is larger than 25 MB.")
                out.write(chunk)
        if size == 0:
            raise VoiceError(400, "empty", "The audio file is empty.")

        wav = Path(tmp) / "audio16k.wav"
        try:
            duration = to_wav16k(src, wav)
        except AudioError as e:
            raise VoiceError(400, "bad_audio", str(e)) from e
        if duration > MAX_SECONDS:
            raise VoiceError(400, "too_long", "Audio is longer than 5 minutes.")

        started = time.monotonic()
        with _gpu_lock:
            try:
                words = asr.whisper_words(wav)
            except asr.AsrError as e:
                raise VoiceError(503, "model_unavailable", str(e)) from e
        elapsed = time.monotonic() - started

    # Log timing only; never the transcript or audio.
    print(f"[voice] transcribed {duration:.1f}s of audio in {elapsed:.1f}s ({len(words)} words)")
    return {
        "words": words,
        "duration_s": round(duration, 2),
        "model": pipeline_config.ASR_MODEL,
        "elapsed_s": round(elapsed, 2),
    }

"""Local voice server: runs BuzzASR (Mongolian Whisper) on this machine's GPU.

The API calls it with PITCH_ASR=remote. It can sit behind a Cloudflare tunnel, so every
transcription request needs `Authorization: Bearer <VOICE_SERVER_TOKEN>`.

Run from the repository root:
    uvicorn voice.server:app --port 8001
"""

import os
import secrets
import shutil
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request, UploadFile
import httpx
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from pipeline import asr, config as pipeline_config, filler_model
from pipeline.audio import AudioError, to_wav16k

TOKEN = os.environ.get("VOICE_SERVER_TOKEN", "").strip()
# Folder of the fine-tuned filler classifier (training/fillers); unset turns /v1/fillers off.
FILLER_MODEL_PATH = os.environ.get("FILLER_MODEL_PATH", "").strip()
PRELOAD = os.environ.get("VOICE_PRELOAD", "1").strip() != "0"
VOICE_TMP_DIR = Path(
    os.environ.get("VOICE_TMP_DIR", str(Path(__file__).resolve().parents[1] / "data" / "voice" / "tmp"))
)
MAX_BYTES = 25 * 1024 * 1024  # same limits as the API's audio upload
MAX_SECONDS = 5 * 60 + 5

# Ollama on this PC, reachable from outside only through the token-protected /v1/ollama route below.
OLLAMA_URL = pipeline_config.OLLAMA_URL
OLLAMA_PATHS = {"api/chat", "api/generate", "api/tags", "api/ps", "api/version"}

# One GPU, one model: transcribe one file at a time.
_gpu_lock = threading.Lock()


def _new_upload_dir() -> Path:
    """Create a per-request directory without tempfile's restrictive Windows ACLs."""
    path = VOICE_TMP_DIR / f"voice-{secrets.token_hex(12)}"
    path.mkdir(parents=True)
    return path


class VoiceError(HTTPException):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(status_code=status, detail={"code": code, "message": message})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not TOKEN:
        raise RuntimeError("Set VOICE_SERVER_TOKEN before starting the voice server.")
    VOICE_TMP_DIR.mkdir(parents=True, exist_ok=True)
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


class FillerRequest(BaseModel):
    sentences: list[str] = Field(max_length=500)


@app.post("/v1/fillers", dependencies=[Depends(require_token)])
def find_fillers(body: FillerRequest):
    """Filler token positions per sentence from the classifier at FILLER_MODEL_PATH (training/fillers)."""
    if not FILLER_MODEL_PATH:
        raise VoiceError(503, "filler_model_off", "Set FILLER_MODEL_PATH on the voice server.")
    with _gpu_lock:
        try:
            marked = filler_model.mark(body.sentences, FILLER_MODEL_PATH)
        except Exception as e:
            raise VoiceError(503, "filler_model_unavailable", "The filler model could not run.") from e
    return {"marked": marked}


@app.post("/v1/transcribe", dependencies=[Depends(require_token)])
def transcribe(file: UploadFile):
    tmp = _new_upload_dir()
    try:
        src = tmp / f"upload{Path(file.filename or '').suffix.lower() or '.bin'}"
        size = 0
        with src.open("wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise VoiceError(413, "too_large", "Audio is larger than 25 MB.")
                out.write(chunk)
        if size == 0:
            raise VoiceError(400, "empty", "The audio file is empty.")

        wav = tmp / "audio16k.wav"
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

    finally:
        # Windows may deny chmod while removing a temp tree; cleanup must not turn
        # a completed transcription (or its original error) into an HTTP 500.
        shutil.rmtree(tmp, ignore_errors=True)

    # Log timing only; never the transcript or audio.
    print(f"[voice] transcribed {duration:.1f}s of audio in {elapsed:.1f}s ({len(words)} words)")
    return {
        "words": words,
        "duration_s": round(duration, 2),
        "model": pipeline_config.ASR_MODEL,
        "elapsed_s": round(elapsed, 2),
    }


@app.api_route("/v1/ollama/{path:path}", methods=["GET", "POST"], dependencies=[Depends(require_token)])
async def ollama_proxy(path: str, request: Request):
    """Forward a request to the local Ollama, streaming the answer back.

    Ollama has no login, so it is never exposed directly; a deployed web app reaches the local
    Gemma through here with the same token as /v1/transcribe. Only the endpoints the app uses
    are allowed. Request and response bodies are not logged.
    """
    if path not in OLLAMA_PATHS:
        raise VoiceError(404, "not_found", "Not an allowed Ollama endpoint.")
    client = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=5.0))
    upstream = client.build_request(
        request.method, f"{OLLAMA_URL}/{path}", content=await request.body(),
        headers={"content-type": request.headers.get("content-type", "application/json")},
    )
    try:
        resp = await client.send(upstream, stream=True)
    except httpx.RequestError as e:
        await client.aclose()
        raise VoiceError(503, "ollama_down", "Ollama isn't running on the voice server's PC.") from e

    async def body():
        try:
            async for chunk in resp.aiter_raw():
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(body(), status_code=resp.status_code,
                             media_type=resp.headers.get("content-type", "application/json"))

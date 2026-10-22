"""AI Pitch Coach API (TDD v2). Run: uvicorn server.main:app --reload"""

import hashlib
import hmac
import logging
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, FastAPI, Header, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from pipeline import audio as audio_tools
from pipeline import config as pipeline_config
from pipeline import slides as slide_tools
from pipeline.feedback import BACKENDS

from . import config, db, errors
from .db import AnalysisReport, AudioAsset, PitchSession, Slide, Transcript
from .errors import ApiError, not_found
from .worker import worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("pitchcoach")


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    try:
        audio_tools.ffmpeg_path()
    except audio_tools.AudioError:
        log.warning("ffmpeg not found; audio uploads will fail")
    removed = db.cleanup_old(config.RETENTION_DAYS)
    if removed:
        log.info("Deleted %d sessions older than %d days", removed, config.RETENTION_DAYS)
    worker.start()
    yield


app = FastAPI(title="AI Pitch Coach API", version="2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)
errors.install(app)
api = APIRouter(prefix="/api/v1")


# ---- Helpers ---------------------------------------------------------------


def get_db():
    with Session(db.engine) as s:
        yield s


DB = Annotated[Session, Depends(get_db)]


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _authorize(session: Session, session_id: str, token: Optional[str]) -> PitchSession:
    """Requests without the right token get 404, so session ids can't be probed."""
    s = session.get(PitchSession, session_id)
    if not s or not token or not hmac.compare_digest(s.access_token_hash, _hash(token)):
        raise not_found()
    return s


def owned_session(session_id: str, database: DB, x_access_token: Annotated[Optional[str], Header()] = None) -> PitchSession:
    return _authorize(database, session_id, x_access_token)


Owned = Annotated[PitchSession, Depends(owned_session)]


def _save_upload(file: UploadFile, dest: Path, max_bytes: int, too_big: str) -> None:
    size = 0
    with dest.open("wb") as out:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                out.close()
                dest.unlink(missing_ok=True)
                raise ApiError(413, "too_large", too_big)
            out.write(chunk)


def _suffix(file: UploadFile, allowed: set[str], message: str) -> str:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in allowed:
        raise ApiError(415, "unsupported_format", message)
    return suffix


def _not_running(s: PitchSession) -> None:
    if s.status == "processing":
        raise ApiError(409, "busy", "This session is being analyzed. Wait for it to finish.")


# ---- Schemas ---------------------------------------------------------------


class CreateSession(BaseModel):
    title: str = Field(default="Untitled pitch", max_length=200)
    goal: str = Field(default="", max_length=500)
    audience: str = Field(default="", max_length=500)
    planned_s: int = Field(ge=30, le=900)
    pitch_type: Literal["startup", "academic"] = "startup"
    group_id: Optional[str] = Field(default=None, max_length=100)


class AnalyzeBody(BaseModel):
    feedback_backend: Optional[str] = None


# ---- Endpoints -------------------------------------------------------------


@api.get("/health")
def health():
    return {
        "ok": True,
        "asr": pipeline_config.ASR_BACKEND,
        "embeddings": pipeline_config.EMBEDDINGS,
        "default_backend": config.DEFAULT_BACKEND,
        "backends": list(BACKENDS),
        "queue_length": len(worker._queue),
    }


@api.post("/sessions", status_code=201)
def create_session(body: CreateSession, database: DB):
    token = secrets.token_urlsafe(32)
    s = PitchSession(
        access_token_hash=_hash(token),
        title=body.title.strip() or "Untitled pitch",
        goal=body.goal.strip(),
        audience=body.audience.strip(),
        planned_s=body.planned_s,
        pitch_type=body.pitch_type,
        group_id=(body.group_id or "").strip() or None,
    )
    database.add(s)
    database.commit()
    db.session_dir(s.id)
    return {"id": s.id, "access_token": token}


@api.post("/sessions/{session_id}/audio")
def upload_audio(s: Owned, database: DB, file: UploadFile):
    _not_running(s)
    suffix = _suffix(file, config.AUDIO_FORMATS, "Audio must be WAV, MP3, M4A, WebM or OGG.")
    folder = db.session_dir(s.id)
    original = folder / f"upload{suffix}"
    wav = folder / "audio.wav"
    _save_upload(file, original, config.AUDIO_MAX_BYTES, "Audio file is larger than 25 MB.")

    try:
        duration = audio_tools.to_wav16k(original, wav)
    except audio_tools.AudioError as e:
        raise ApiError(400, "bad_audio", str(e))
    if duration > config.AUDIO_MAX_S + 1:
        wav.unlink(missing_ok=True)
        raise ApiError(413, "too_long", f"Audio is {int(duration // 60)}:{int(duration % 60):02d} long. The limit is 5:00.")
    if duration < 3:
        raise ApiError(400, "too_short", "Audio is shorter than 3 seconds.")

    asset = database.get(AudioAsset, s.id) or AudioAsset(session_id=s.id, path="", duration_s=0, format="")
    asset.path, asset.duration_s, asset.format = str(wav), round(duration, 2), suffix.lstrip(".")
    database.add(asset)
    db.clear_results(database, s.id)  # a new recording makes an old report stale
    s.status, s.stage, s.error = "uploaded", None, None
    database.add(s)
    database.commit()
    return {"duration_s": asset.duration_s, "format": asset.format}


@api.post("/sessions/{session_id}/slides")
def upload_slides(s: Owned, database: DB, file: UploadFile):
    _not_running(s)
    suffix = _suffix(file, config.SLIDES_FORMATS, "Slides must be a PDF or PPTX file.")
    path = db.session_dir(s.id) / f"slides{suffix}"
    _save_upload(file, path, config.SLIDES_MAX_BYTES, "Slides file is larger than 20 MB.")

    try:
        extracted = slide_tools.extract(path)
    except slide_tools.SlidesError as e:
        raise ApiError(400, "bad_slides", str(e))
    if not extracted:
        raise ApiError(400, "bad_slides", "The slides file has no pages.")
    if len(extracted) > config.SLIDES_MAX_COUNT:
        raise ApiError(413, "too_many_slides", f"The deck has {len(extracted)} slides. The limit is {config.SLIDES_MAX_COUNT}.")

    for old in database.exec(select(Slide).where(Slide.session_id == s.id)).all():
        database.delete(old)
    for sl in extracted:
        database.add(Slide(session_id=s.id, **sl))
    database.commit()
    return {
        "slide_count": len(extracted),
        "image_only": [sl["number"] for sl in extracted if sl["image_only"]],
    }


@api.post("/sessions/{session_id}/analyze", status_code=202)
def analyze(s: Owned, database: DB, body: Optional[AnalyzeBody] = None):
    _not_running(s)
    if not database.get(AudioAsset, s.id):
        raise ApiError(409, "no_audio", "Upload or record audio first.")
    backend = (body.feedback_backend if body else None) or config.DEFAULT_BACKEND
    if backend not in BACKENDS:
        raise ApiError(422, "invalid_request", f"Unknown feedback model '{backend}'. Use one of: {', '.join(BACKENDS)}.")

    s.status, s.stage, s.error, s.feedback_backend = "processing", None, None, backend
    database.add(s)
    database.commit()
    position = worker.enqueue(s.id)
    return {"status": s.status, "queue_position": position}


@api.get("/sessions/{session_id}/status")
def status(s: Owned):
    return {
        "status": s.status,
        "stage": s.stage,
        "queue_position": worker.position(s.id) if s.status == "processing" else None,
        "error": s.error,
    }


def _report(database: Session, s: PitchSession) -> dict:
    r = database.get(AnalysisReport, s.id)
    t = database.get(Transcript, s.id)
    if s.status != "completed" or not r or not t:
        raise ApiError(409, "not_ready", "The report is not ready yet.")
    return {
        "session_id": s.id,
        "title": s.title,
        "group_id": s.group_id,
        "overall": r.overall,
        "content": r.content,
        "delivery": r.delivery,
        "slide_alignment": r.slide_alignment,
        "timing": r.timing,
        "categories_used": r.extra.get("categories_used"),
        "delivery_parts": r.extra.get("delivery_parts"),
        "metrics": r.metrics,
        "wording": r.extra.get("wording"),
        "slide_results": r.slide_results,
        "feedback": r.feedback,
        "transcript": {"text": t.text, "sentences": t.sentences},
        "backend": r.backend,
        "asr_backend": r.extra.get("asr_backend"),
        "notes": r.extra.get("notes", []),
        "created_at": r.created_at.isoformat(),
    }


@api.get("/sessions/{session_id}/report")
def report(s: Owned, database: DB):
    return _report(database, s)


COMPARE_FIELDS = ["overall", "content", "delivery", "slide_alignment", "timing"]
COMPARE_METRICS = ["duration_s", "wpm", "fillers_per_100", "long_pauses_per_min", "pitch_range_st", "end_volume_drop_db"]


@api.get("/sessions/compare")
def compare(
    database: DB,
    a: Annotated[str, Query()],
    b: Annotated[str, Query()],
    x_access_token_a: Annotated[Optional[str], Header()] = None,
    x_access_token_b: Annotated[Optional[str], Header()] = None,
):
    """Before and after (FR-10). The browser sends both sessions' tokens as headers."""
    ra = _report(database, _authorize(database, a, x_access_token_a))
    rb = _report(database, _authorize(database, b, x_access_token_b))

    def delta(x, y):
        return round(y - x, 2) if isinstance(x, (int, float)) and isinstance(y, (int, float)) else None

    changes = {f: {"a": ra[f], "b": rb[f], "delta": delta(ra[f], rb[f])} for f in COMPARE_FIELDS}
    for m in COMPARE_METRICS:
        x, y = ra["metrics"].get(m), rb["metrics"].get(m)
        changes[m] = {"a": x, "b": y, "delta": delta(x, y)}

    def summary(r):
        return {"id": r["session_id"], "title": r["title"], "created_at": r["created_at"], "backend": r["backend"]}

    return {"a": summary(ra), "b": summary(rb), "changes": changes}


@api.delete("/sessions/{session_id}", status_code=204)
def delete_session(s: Owned, database: DB):
    if worker.current == s.id:
        raise ApiError(409, "busy", "This session is being analyzed. Delete it after it finishes.")
    worker.remove(s.id)
    db.delete_session(database, s.id)
    return Response(status_code=204)


app.include_router(api)

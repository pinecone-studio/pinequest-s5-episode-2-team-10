"""AI Pitch Coach API (TDD v2 + projects). Run: uvicorn server.main:app --reload"""

import hashlib
import logging
import mimetypes
import secrets
import shutil
from contextlib import asynccontextmanager
from datetime import timezone
from pathlib import Path
from typing import Annotated, Literal, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, FastAPI, Header, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import AfterValidator, BaseModel, Field
from sqlmodel import Session, func, select

from pipeline import audio as audio_tools
from pipeline import config as pipeline_config
from pipeline import slides as slide_tools
from pipeline.feedback import BACKENDS
from pipeline.points import clean_points

from . import config, db, errors, storage
from .db import AccessToken, AnalysisReport, AppUser, AudioAsset, PitchSession, Project, Slide, Transcript, utcnow
from .errors import ApiError, not_found
from .worker import worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("pitchcoach")

mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/webm", ".webm")
mimetypes.add_type("audio/ogg", ".ogg")
mimetypes.add_type("application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx")


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    try:
        audio_tools.ffmpeg_path()
    except audio_tools.AudioError:
        log.warning("ffmpeg not found; audio uploads will fail")
    removed = db.cleanup_old(config.RETENTION_DAYS)
    if removed:
        log.info("Deleted %d projects untouched for %d days", removed, config.RETENTION_DAYS)
    worker.start()
    yield


app = FastAPI(title="AI Pitch Coach API", version="2.1", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_origin_regex=r"https?://.*",
    allow_methods=["*"],
    allow_headers=["*"],
)
errors.install(app)
api = APIRouter(prefix="/api/v1")


# ---- Auth and ownership ----------------------------------------------------


def get_db():
    with Session(db.engine) as s:
        yield s


DB = Annotated[Session, Depends(get_db)]


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def current_user(database: DB, x_access_token: Annotated[Optional[str], Header()] = None) -> AppUser:
    """No accounts yet: each browser gets an anonymous user and sends its token on every request."""
    if not x_access_token:
        raise ApiError(401, "unauthorized", "Missing access token.")
    token_hash = _hash(x_access_token)
    user = database.exec(select(AppUser).where(AppUser.token_hash == token_hash)).first()
    if not user:
        extra_token = database.get(AccessToken, token_hash)
        user = database.get(AppUser, extra_token.user_id) if extra_token else None
    if not user:
        raise ApiError(401, "unauthorized", "Unknown access token.")
    return user


User = Annotated[AppUser, Depends(current_user)]


def owned_project(project_id: str, user: User, database: DB) -> Project:
    p = database.get(Project, project_id)
    if not p or p.user_id != user.id:
        raise not_found("Project")
    return p


def owned_session(session_id: str, user: User, database: DB) -> PitchSession:
    s = database.get(PitchSession, session_id)
    p = database.get(Project, s.project_id) if s else None
    if not s or not p or p.user_id != user.id:
        raise not_found("Attempt")
    return s


OwnedProject = Annotated[Project, Depends(owned_project)]
Owned = Annotated[PitchSession, Depends(owned_session)]


# ---- Helpers ---------------------------------------------------------------


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
        raise ApiError(409, "busy", "This attempt is being analyzed. Wait for it to finish.")


def _slides_path(s: PitchSession) -> Optional[Path]:
    if not s.slides_filename:
        return None
    return config.SESSIONS_DIR / s.id / f"slides{Path(s.slides_filename).suffix.lower()}"


def _slides_object_key(s: PitchSession) -> Optional[str]:
    if not s.slides_filename:
        return None
    suffix = Path(s.slides_filename).suffix.lower()
    return f"sessions/{s.id}/slides{suffix}"


def _storage_failure(exc: storage.StorageError) -> ApiError:
    log.error("Supabase Storage operation failed: %s", exc)
    return ApiError(503, "storage_unavailable", "File storage is temporarily unavailable.")


def _attempt(database: Session, s: PitchSession) -> dict:
    report = database.get(AnalysisReport, s.id)
    audio = database.get(AudioAsset, s.id)
    slide_count = database.exec(select(func.count()).select_from(Slide).where(Slide.session_id == s.id)).one()
    return {
        "id": s.id,
        "created_at": _iso(s.created_at),
        "status": s.status,
        "stage": s.stage,
        "error": s.error,
        "backend": s.feedback_backend,
        "overall": report.overall if report else None,
        "duration_s": audio.duration_s if audio else None,
        "slides_filename": s.slides_filename,
        "slide_count": slide_count,
        "has_script": bool(s.script.strip()),
    }


def _sessions(database: Session, project_id: str) -> list[PitchSession]:
    return database.exec(
        select(PitchSession).where(PitchSession.project_id == project_id).order_by(PitchSession.created_at.desc())
    ).all()


def _project(database: Session, p: Project, with_attempts: bool) -> dict:
    sessions = _sessions(database, p.id)
    analyzed = [s for s in sessions if s.status in ("processing", "completed", "failed")]
    latest_done = next((s for s in sessions if s.status == "completed"), None)
    latest_report = database.get(AnalysisReport, latest_done.id) if latest_done else None
    out = {
        "id": p.id,
        "name": p.name,
        "goal": p.goal,
        "audience": p.audience,
        "idea": p.idea,
        "key_points": p.key_points or [],
        "planned_s": p.planned_s,
        "pitch_type": p.pitch_type,
        "created_at": _iso(p.created_at),
        "updated_at": _iso(p.updated_at),
        "attempt_count": len(analyzed),
        "latest_overall": latest_report.overall if latest_report else None,
        "processing": any(s.status == "processing" for s in sessions),
    }
    if with_attempts:
        out["attempts"] = [_attempt(database, s) for s in analyzed]
        # Inputs the next attempt will reuse (slides and script from the most recent attempt).
        latest = sessions[0] if sessions else None
        out["current"] = {
            "slides_filename": latest.slides_filename if latest else None,
            "slide_count": _attempt(database, latest)["slide_count"] if latest else 0,
            "script": latest.script if latest else "",
        }
    return out


def _iso(dt) -> str:
    """SQLite returns naive datetimes; they are stored as UTC, so say so."""
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()


def _touch(database: Session, project_id: str) -> None:
    p = database.get(Project, project_id)
    if p:
        p.updated_at = utcnow()
        database.add(p)


# ---- Schemas ---------------------------------------------------------------

PitchType = Literal["startup", "academic"]


# Up to 6 main points; blank ones are dropped and spaces trimmed (same rules as the pipeline).
KeyPoints = Annotated[
    list[Annotated[str, Field(max_length=200)]],
    Field(max_length=6),
    AfterValidator(clean_points),
]


class ProjectBody(BaseModel):
    name: str = Field(default="Untitled project", max_length=200)
    goal: str = Field(default="", max_length=500)
    audience: str = Field(default="", max_length=500)
    idea: str = Field(default="", max_length=500)
    key_points: KeyPoints = []
    planned_s: int = Field(default=180, ge=30, le=900)
    pitch_type: PitchType = "startup"


class ProjectPatch(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    goal: Optional[str] = Field(default=None, max_length=500)
    audience: Optional[str] = Field(default=None, max_length=500)
    idea: Optional[str] = Field(default=None, max_length=500)
    key_points: Optional[KeyPoints] = None
    planned_s: Optional[int] = Field(default=None, ge=30, le=900)
    pitch_type: Optional[PitchType] = None


class NewAttempt(BaseModel):
    copy_inputs: bool = True  # reuse slides and script from the latest attempt


class ScriptBody(BaseModel):
    text: str = Field(max_length=20000)


class AnalyzeBody(BaseModel):
    feedback_backend: Optional[str] = None


# ---- Users and projects ----------------------------------------------------


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


@api.post("/users", status_code=201)
def create_user(database: DB):
    token = secrets.token_urlsafe(32)
    user = AppUser(token_hash=_hash(token))
    database.add(user)
    database.commit()
    return {"id": user.id, "access_token": token}


@api.get("/projects")
def list_projects(user: User, database: DB):
    projects = database.exec(
        select(Project).where(Project.user_id == user.id).order_by(Project.updated_at.desc())
    ).all()
    return [_project(database, p, with_attempts=False) for p in projects]


@api.post("/projects", status_code=201)
def create_project(body: ProjectBody, user: User, database: DB):
    p = Project(user_id=user.id, **body.model_dump())
    p.name = p.name.strip() or "Untitled project"
    database.add(p)
    database.commit()
    return _project(database, p, with_attempts=True)


@api.get("/projects/{project_id}")
def get_project(p: OwnedProject, database: DB):
    return _project(database, p, with_attempts=True)


@api.patch("/projects/{project_id}")
def update_project(body: ProjectPatch, p: OwnedProject, database: DB):
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(p, k, v.strip() if isinstance(v, str) else v)
    if not p.name:
        p.name = "Untitled project"
    p.updated_at = utcnow()
    database.add(p)
    database.commit()
    return _project(database, p, with_attempts=True)


@api.delete("/projects/{project_id}", status_code=204)
def delete_project(p: OwnedProject, database: DB):
    sessions = _sessions(database, p.id)
    if any(worker.current == s.id for s in sessions):
        raise ApiError(409, "busy", "An attempt in this project is being analyzed. Delete it after it finishes.")
    try:
        db.delete_project(database, p.id)
    except storage.StorageError as exc:
        raise _storage_failure(exc) from exc
    for s in sessions:
        worker.remove(s.id)
    return Response(status_code=204)


@api.post("/projects/{project_id}/sessions", status_code=201)
def create_attempt(p: OwnedProject, database: DB, body: Optional[NewAttempt] = None):
    s = PitchSession(
        project_id=p.id, title=p.name, goal=p.goal, audience=p.audience,
        idea=p.idea, key_points=list(p.key_points or []),
        planned_s=p.planned_s, pitch_type=p.pitch_type,
    )
    previous = _sessions(database, p.id)
    database.add(s)
    database.flush()

    if (body is None or body.copy_inputs) and previous:
        prev = previous[0]
        s.script = prev.script
        src = _slides_path(prev)
        if storage.configured() and prev.slides_filename:
            source_key = _slides_object_key(prev)
            target_key = _slides_object_key(s)
            if source_key is None or target_key is None:
                raise ApiError(500, "invalid_file_reference", "The stored slide reference is invalid.")
            try:
                content = storage.download_bytes(source_key)
                storage.upload_bytes(
                    target_key,
                    content,
                    mimetypes.guess_type(prev.slides_filename)[0] or "application/octet-stream",
                )
            except storage.StorageError as exc:
                raise _storage_failure(exc) from exc
            s.slides_filename = prev.slides_filename
            for sl in database.exec(select(Slide).where(Slide.session_id == prev.id)).all():
                database.add(Slide(session_id=s.id, number=sl.number, text=sl.text, notes=sl.notes,
                                   image_only=sl.image_only, numbers=sl.numbers, key_terms=sl.key_terms))
        elif src and src.exists():
            shutil.copy(src, db.session_dir(s.id) / src.name)
            s.slides_filename = prev.slides_filename
            for sl in database.exec(select(Slide).where(Slide.session_id == prev.id)).all():
                database.add(Slide(session_id=s.id, number=sl.number, text=sl.text, notes=sl.notes,
                                   image_only=sl.image_only, numbers=sl.numbers, key_terms=sl.key_terms))
    _touch(database, p.id)
    database.add(s)
    database.commit()
    return _attempt(database, s)


# ---- Attempt inputs --------------------------------------------------------


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
        original.unlink(missing_ok=True)
        raise ApiError(400, "bad_audio", str(e))
    if duration > config.AUDIO_MAX_S + 1:
        wav.unlink(missing_ok=True)
        original.unlink(missing_ok=True)
        raise ApiError(413, "too_long", f"Audio is {int(duration // 60)}:{int(duration % 60):02d} long. The limit is 5:00.")
    if duration < 3:
        wav.unlink(missing_ok=True)
        original.unlink(missing_ok=True)
        raise ApiError(400, "too_short", "Audio is shorter than 3 seconds.")

    asset = database.get(AudioAsset, s.id)
    old_paths = (asset.path, asset.original_path) if asset else ()
    asset = asset or AudioAsset(session_id=s.id, path="", original_path="", duration_s=0, format="")
    if storage.configured():
        original_key = f"sessions/{s.id}/original{suffix}"
        wav_key = f"sessions/{s.id}/audio.wav"
        uploaded_keys = []
        try:
            storage.upload_file(
                original_key,
                original,
                mimetypes.guess_type(original.name)[0] or "application/octet-stream",
            )
            uploaded_keys.append(original_key)
            storage.upload_file(wav_key, wav, "audio/wav")
            uploaded_keys.append(wav_key)
        except storage.StorageError as exc:
            if uploaded_keys:
                try:
                    storage.delete_objects(uploaded_keys)
                except storage.StorageError as cleanup_error:
                    log.warning("Could not clean up incomplete audio upload for session %s: %s", s.id, cleanup_error)
            raise _storage_failure(exc) from exc
        asset.path, asset.original_path = storage.uri_for(wav_key), storage.uri_for(original_key)
    else:
        asset.path, asset.original_path = str(wav), str(original)
    asset.duration_s, asset.format = round(duration, 2), suffix.lstrip(".")
    database.add(asset)
    db.clear_results(database, s.id)  # a new recording makes an old report stale
    s.status, s.stage, s.error = "uploaded", None, None
    database.add(s)
    database.commit()
    if storage.configured():
        original.unlink(missing_ok=True)
        wav.unlink(missing_ok=True)
        obsolete_keys = [
            key for value in old_paths
            if (key := storage.key_from_uri(value)) and key not in (original_key, wav_key)
        ]
        if obsolete_keys:
            try:
                storage.delete_objects(obsolete_keys)
            except storage.StorageError as exc:
                log.warning("Could not remove replaced audio objects for session %s: %s", s.id, exc)
    return {"duration_s": asset.duration_s, "format": asset.format}


@api.post("/sessions/{session_id}/slides")
def upload_slides(s: Owned, database: DB, file: UploadFile):
    _not_running(s)
    suffix = _suffix(file, config.SLIDES_FORMATS, "Slides must be a PDF or PPTX file.")
    folder = db.session_dir(s.id)
    path = folder / f"upload-slides{suffix}"
    _save_upload(file, path, config.SLIDES_MAX_BYTES, "Slides file is larger than 20 MB.")

    try:
        extracted = slide_tools.extract(path)
    except slide_tools.SlidesError as e:
        path.unlink(missing_ok=True)
        raise ApiError(400, "bad_slides", str(e))
    if not extracted:
        path.unlink(missing_ok=True)
        raise ApiError(400, "bad_slides", "The slides file has no pages.")
    if len(extracted) > config.SLIDES_MAX_COUNT:
        path.unlink(missing_ok=True)
        raise ApiError(413, "too_many_slides", f"The deck has {len(extracted)} slides. The limit is {config.SLIDES_MAX_COUNT}.")

    old_key = _slides_object_key(s)
    new_key = f"sessions/{s.id}/slides{suffix}"
    if storage.configured():
        try:
            storage.upload_file(
                new_key,
                path,
                mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            )
        except storage.StorageError as exc:
            path.unlink(missing_ok=True)
            raise _storage_failure(exc) from exc
        path.unlink(missing_ok=True)
    else:
        for old in folder.glob("slides.*"):
            old.unlink(missing_ok=True)
        path.rename(folder / f"slides{suffix}")
    for old in database.exec(select(Slide).where(Slide.session_id == s.id)).all():
        database.delete(old)
    for sl in extracted:
        database.add(Slide(session_id=s.id, **sl))
    s.slides_filename = Path(file.filename or f"slides{suffix}").name
    database.add(s)
    database.commit()
    if storage.configured() and old_key and old_key != new_key:
        try:
            storage.delete_objects([old_key])
        except storage.StorageError as exc:
            log.warning("Could not remove replaced slide object for session %s: %s", s.id, exc)
    return {
        "slide_count": len(extracted),
        "image_only": [sl["number"] for sl in extracted if sl["image_only"]],
        "filename": s.slides_filename,
    }


@api.delete("/sessions/{session_id}/slides", status_code=204)
def remove_slides(s: Owned, database: DB):
    _not_running(s)
    for old in database.exec(select(Slide).where(Slide.session_id == s.id)).all():
        database.delete(old)
    path = _slides_path(s)
    key = _slides_object_key(s)
    if storage.configured() and key:
        try:
            storage.delete_objects([key])
        except storage.StorageError as exc:
            raise _storage_failure(exc) from exc
    elif path:
        path.unlink(missing_ok=True)
    s.slides_filename = None
    database.add(s)
    database.commit()
    return Response(status_code=204)


@api.put("/sessions/{session_id}/script")
def set_script(body: ScriptBody, s: Owned, database: DB):
    _not_running(s)
    s.script = body.text.strip()
    database.add(s)
    database.commit()
    return {"words": len(s.script.split())}


# ---- Viewing uploads -------------------------------------------------------


@api.get("/sessions/{session_id}/audio")
def get_audio(s: Owned, database: DB):
    asset = database.get(AudioAsset, s.id)
    if not asset:
        raise not_found("Audio")
    object_key = storage.key_from_uri(asset.original_path)
    if object_key:
        try:
            content = storage.download_bytes(object_key)
        except storage.StorageNotFound as exc:
            raise not_found("Audio") from exc
        except storage.StorageError as exc:
            raise _storage_failure(exc) from exc
        filename = Path(object_key).name
        return Response(
            content=content,
            media_type=mimetypes.guess_type(filename)[0] or "application/octet-stream",
        )
    path = Path(asset.original_path)
    if not path.exists():
        raise not_found("Audio")
    return FileResponse(path, media_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream")


@api.get("/sessions/{session_id}/slides")
def get_slides(s: Owned, database: DB):
    rows = database.exec(select(Slide).where(Slide.session_id == s.id).order_by(Slide.number)).all()
    return {
        "filename": s.slides_filename,
        "slides": [{"number": r.number, "text": r.text, "notes": r.notes, "image_only": r.image_only} for r in rows],
    }


@api.get("/sessions/{session_id}/slides/file")
def get_slides_file(s: Owned):
    object_key = _slides_object_key(s)
    if storage.configured() and object_key:
        try:
            content = storage.download_bytes(object_key)
        except storage.StorageNotFound as exc:
            raise not_found("Slides") from exc
        except storage.StorageError as exc:
            raise _storage_failure(exc) from exc
        filename = s.slides_filename or "slides"
        return Response(
            content=content,
            media_type=mimetypes.guess_type(filename)[0] or "application/octet-stream",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename, safe='')}"},
        )
    path = _slides_path(s)
    if not path or not path.exists():
        raise not_found("Slides")
    return FileResponse(path, filename=s.slides_filename, media_type=mimetypes.guess_type(path.name)[0])


@api.get("/sessions/{session_id}/script")
def get_script(s: Owned):
    return {"text": s.script}


# ---- Analysis --------------------------------------------------------------


@api.post("/sessions/{session_id}/analyze", status_code=202)
def analyze(s: Owned, database: DB, body: Optional[AnalyzeBody] = None):
    _not_running(s)
    if not database.get(AudioAsset, s.id):
        raise ApiError(409, "no_audio", "Upload or record audio first.")
    backend = (body.feedback_backend if body else None) or config.DEFAULT_BACKEND
    if backend not in BACKENDS:
        raise ApiError(422, "invalid_request", f"Unknown feedback model '{backend}'. Use one of: {', '.join(BACKENDS)}.")

    # Use the project's details as they are now.
    p = database.get(Project, s.project_id)
    s.title, s.goal, s.audience, s.planned_s, s.pitch_type = p.name, p.goal, p.audience, p.planned_s, p.pitch_type
    s.idea, s.key_points = p.idea, list(p.key_points or [])
    s.status, s.stage, s.error, s.feedback_backend = "processing", None, None, backend
    database.add(s)
    _touch(database, p.id)
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
        "project_id": s.project_id,
        "title": s.title,
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
        "script": s.script,
        "slides_filename": s.slides_filename,
        "backend": r.backend,
        "asr_backend": r.extra.get("asr_backend"),
        "notes": r.extra.get("notes", []),
        "created_at": _iso(r.created_at),
    }


@api.get("/sessions/{session_id}/report")
def report(s: Owned, database: DB):
    return _report(database, s)


COMPARE_FIELDS = ["overall", "content", "delivery", "slide_alignment", "timing"]
COMPARE_METRICS = ["duration_s", "wpm", "fillers_per_100", "long_pauses_per_min", "pitch_range_st", "end_volume_drop_db"]


@api.get("/sessions/compare")
def compare(user: User, database: DB, a: Annotated[str, Query()], b: Annotated[str, Query()]):
    """Before and after (FR-10) for two of the user's attempts."""
    ra = _report(database, owned_session(a, user, database))
    rb = _report(database, owned_session(b, user, database))

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
def delete_attempt(s: Owned, database: DB):
    if worker.current == s.id:
        raise ApiError(409, "busy", "This attempt is being analyzed. Delete it after it finishes.")
    try:
        db.delete_session(database, s.id)
    except storage.StorageError as exc:
        raise _storage_failure(exc) from exc
    worker.remove(s.id)
    return Response(status_code=204)


app.include_router(api)

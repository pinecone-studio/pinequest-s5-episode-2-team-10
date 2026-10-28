"""AI Pitch Coach API (TDD v2 + projects). Run: uvicorn server.main:app --reload"""

import hashlib
import io
import logging
import mimetypes
import re
import secrets
import shutil
import unicodedata
import warnings
from contextlib import asynccontextmanager
from datetime import timezone
from pathlib import Path
from typing import Annotated, Literal, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, FastAPI, Header, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator
from sqlmodel import Session, func, select

from pipeline import audio as audio_tools
from pipeline import config as pipeline_config
from pipeline import slides as slide_tools
from pipeline.feedback import BACKENDS
from pipeline.points import clean_points

from . import config, db, errors, storage
from .db import AccessToken, AnalysisReport, AppUser, AudioAsset, PitchSession, Project, Slide, Transcript, utcnow
from .errors import ApiError, not_found
from .passwords import hash_password, verify_password
from . import supabase_auth
from .worker import worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("pitchcoach")

mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/webm", ".webm")
mimetypes.add_type("audio/ogg", ".ogg")
mimetypes.add_type("application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx")

PROFILE_AVATAR_MAX_BYTES = 5 * 1024 * 1024
PROFILE_AVATAR_MAX_PIXELS = 20_000_000
DEMO_AVATAR_PATH = Path(__file__).resolve().parent / "assets" / "demo-avatar.webp"


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
    if not user.is_active:
        raise ApiError(403, "account_disabled", "This account has been disabled.")
    return user


User = Annotated[AppUser, Depends(current_user)]


def admin_user(user: User) -> AppUser:
    if user.role != "admin":
        raise ApiError(403, "admin_required", "Administrator access is required.")
    return user


AdminUser = Annotated[AppUser, Depends(admin_user)]


def owned_project(project_id: str, user: User, database: DB) -> Project:
    p = database.get(Project, project_id)
    if not p or (p.user_id != user.id and user.role != "admin"):
        raise not_found("Project")
    return p


def owned_session(session_id: str, user: User, database: DB) -> PitchSession:
    s = database.get(PitchSession, session_id)
    p = database.get(Project, s.project_id) if s else None
    if not s or not p or (p.user_id != user.id and user.role != "admin"):
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


def _slides_object_key(s: PitchSession, filename: Optional[str] = None) -> Optional[str]:
    stored_filename = filename or s.slides_filename
    if not stored_filename:
        return None
    suffix = Path(stored_filename).suffix.lower()
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
        "audio_filename": s.audio_filename,
        "has_audio": audio is not None,
        "slides_filename": s.slides_filename,
        "slide_count": slide_count,
        "has_script": bool(s.script.strip()),
    }


def _sessions(database: Session, project_id: str) -> list[PitchSession]:
    return database.exec(
        select(PitchSession).where(PitchSession.project_id == project_id).order_by(PitchSession.created_at.desc())
    ).all()


def _project(database: Session, p: Project, with_attempts: bool, include_owner: bool = False) -> dict:
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
        "point_slides": p.point_slides or [],
        "figma_url": p.figma_url,
        "script": p.script,
        "selected_audio_id": p.selected_audio_id,
        "planned_s": p.planned_s,
        "pitch_type": p.pitch_type,
        "created_at": _iso(p.created_at),
        "updated_at": _iso(p.updated_at),
        "attempt_count": len(analyzed),
        "latest_overall": latest_report.overall if latest_report else None,
        "processing": any(s.status == "processing" for s in sessions),
    }
    if with_attempts:
        out["attempts"] = [_attempt(database, s) for s in sessions]
        # Inputs the next attempt will reuse (slides and script from the most recent attempt).
        latest = sessions[0] if sessions else None
        out["current"] = {
            "slides_filename": latest.slides_filename if latest else None,
            "slide_count": _attempt(database, latest)["slide_count"] if latest else 0,
            "script": p.script or (latest.script if latest else ""),
            "session_id": latest.id if latest else None,
        }
    if include_owner:
        owner = database.get(AppUser, p.user_id)
        out["owner_id"] = p.user_id
        out["owner_email"] = owner.email if owner else None
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
    point_slides: list[Optional[int]] = Field(default_factory=list, max_length=6)
    figma_url: Optional[str] = Field(default=None, max_length=2048)
    script: str = Field(default="", max_length=20000)
    planned_s: int = Field(default=180, ge=30, le=900)
    pitch_type: PitchType = "startup"


class ProjectPatch(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    goal: Optional[str] = Field(default=None, max_length=500)
    audience: Optional[str] = Field(default=None, max_length=500)
    idea: Optional[str] = Field(default=None, max_length=500)
    key_points: Optional[KeyPoints] = None
    point_slides: Optional[list[Optional[int]]] = Field(default=None, max_length=6)
    figma_url: Optional[str] = Field(default=None, max_length=2048)
    script: Optional[str] = Field(default=None, max_length=20000)
    selected_audio_id: Optional[str] = None
    planned_s: Optional[int] = Field(default=None, ge=30, le=900)
    pitch_type: Optional[PitchType] = None


class NewAttempt(BaseModel):
    copy_inputs: bool = True  # reuse slides and script from the latest attempt


class ScriptBody(BaseModel):
    text: str = Field(max_length=20000)


class AnalyzeBody(BaseModel):
    feedback_backend: Optional[str] = None


class RegisterBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=1, max_length=254)
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=128)


class LoginBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    login: str = Field(min_length=1, max_length=254, description="Email address or username.")
    password: str = Field(min_length=8, max_length=128)


class GoogleAuthBody(BaseModel):
    access_token: str = Field(min_length=1, max_length=8192)


class AdminUserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Optional[Literal["member", "admin"]] = None
    is_active: Optional[bool] = None

    @model_validator(mode="after")
    def require_update(self):
        if (
            not self.model_fields_set
            or ("role" in self.model_fields_set and self.role is None)
            or ("is_active" in self.model_fields_set and self.is_active is None)
        ):
            raise ValueError("Provide a role or is_active value.")
        return self


class UserProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=1, max_length=64)


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required when the account already has a password; Google-only accounts set their first one without it.
    current_password: Optional[str] = Field(default=None, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class AdminUserView(BaseModel):
    id: str
    email: Optional[str]
    role: Literal["member", "admin"]
    is_active: bool
    created_at: str


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


def _normalized_email(email: str) -> str:
    normalized = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized):
        raise ApiError(422, "invalid_email", "Enter a valid email address.")
    return normalized


def _normalized_username(username: str) -> str:
    normalized = unicodedata.normalize("NFC", username.strip()).casefold()
    if not 1 <= len(normalized) <= 40:
        raise ApiError(
            422,
            "invalid_username",
            "Enter a username from 1 to 40 characters.",
        )
    return normalized


def _profile_avatar_webp(content: bytes) -> bytes:
    if not content:
        raise ApiError(400, "empty_avatar", "Choose an image first.")
    if len(content) > PROFILE_AVATAR_MAX_BYTES:
        raise ApiError(413, "avatar_too_large", "Profile images must be 5 MB or smaller.")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as source:
                if source.format not in {"JPEG", "PNG", "WEBP"} or getattr(source, "n_frames", 1) > 1:
                    raise ApiError(415, "invalid_avatar", "Upload a JPG, PNG, or WebP image.")
                if source.width * source.height > PROFILE_AVATAR_MAX_PIXELS:
                    raise ApiError(413, "avatar_too_large", "Image dimensions are too large.")
                source.verify()

            with Image.open(io.BytesIO(content)) as source:
                has_alpha = source.mode in {"RGBA", "LA"} or "transparency" in source.info
                image = ImageOps.exif_transpose(source).convert("RGBA" if has_alpha else "RGB")
                image.thumbnail((512, 512), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                image.save(output, format="WEBP", quality=85, method=6)
                return output.getvalue()
    except ApiError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ApiError(415, "invalid_avatar", "Upload a valid JPG, PNG, or WebP image.") from exc


def _auth_response(user: AppUser, token: str) -> dict:
    return {"id": user.id, "email": user.email, "username": user.username, "role": user.role, "access_token": token}


def _replace_user_token(database: Session, user: AppUser) -> dict:
    token = secrets.token_urlsafe(32)
    for old_token in database.exec(select(AccessToken).where(AccessToken.user_id == user.id)).all():
        database.delete(old_token)
    user.token_hash = _hash(token)
    database.add(user)
    database.commit()
    return _auth_response(user, token)


@api.post("/auth/register", status_code=201)
def register(body: RegisterBody, database: DB):
    email = _normalized_email(body.email)
    username = _normalized_username(body.username)
    if email == "demo@pitchcoach.local":
        raise ApiError(409, "email_taken", "This email address is already registered.")
    if database.exec(select(AppUser).where(func.lower(AppUser.email) == email)).first():
        raise ApiError(409, "email_taken", "This email address is already registered.")
    if database.exec(select(AppUser).where(func.lower(AppUser.username) == username)).first():
        raise ApiError(409, "username_taken", "This username is already taken.")

    token = secrets.token_urlsafe(32)
    user = AppUser(
        email=email,
        username=username,
        password_hash=hash_password(body.password),
        token_hash=_hash(token),
    )
    database.add(user)
    database.commit()
    database.refresh(user)
    return _auth_response(user, token)


@api.post("/auth/login")
def login(body: LoginBody, database: DB):
    identifier = unicodedata.normalize("NFC", body.login.strip()).casefold()
    user = None
    if "@" in identifier:
        user = database.exec(select(AppUser).where(func.lower(AppUser.email) == identifier)).first()
    if user is None:
        user = database.exec(select(AppUser).where(func.lower(AppUser.username) == identifier)).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise ApiError(401, "invalid_credentials", "Email, username, or password is incorrect.")
    if not user.is_active:
        raise ApiError(401, "invalid_credentials", "Email, username, or password is incorrect.")
    return _replace_user_token(database, user)


@api.post("/auth/demo")
def demo_login(database: DB):
    email = "demo@pitchcoach.local"
    user = database.exec(select(AppUser).where(AppUser.email == email)).first()
    token = secrets.token_urlsafe(32)
    if user is None:
        user = AppUser(email=email, role="admin", password_hash=None, token_hash=_hash(token))
        database.add(user)
    else:
        if not user.is_active:
            raise ApiError(403, "demo_unavailable", "The shared demo account is unavailable.")
        # The shared demo login intentionally enters the admin experience.
        user.role = "admin"
        database.add(user)
        database.add(AccessToken(token_hash=_hash(token), user_id=user.id))
    database.commit()
    database.refresh(user)
    return _auth_response(user, token)


@api.post("/auth/google")
def google_login(body: GoogleAuthBody, database: DB):
    email = _normalized_email(supabase_auth.google_email(body.access_token))
    if email == "demo@pitchcoach.local":
        raise ApiError(401, "invalid_google_token", "This Google account cannot use the demo account.")
    user = database.exec(select(AppUser).where(func.lower(AppUser.email) == email)).first()
    if user is None:
        user = AppUser(
            email=email,
            role="admin" if email in config.ADMIN_EMAILS else "member",
            token_hash=_hash(secrets.token_urlsafe(32)),
        )
        database.add(user)
        database.commit()
        database.refresh(user)
    elif not user.is_active:
        raise ApiError(403, "account_disabled", "This account has been disabled.")
    elif email in config.ADMIN_EMAILS and user.role != "admin":
        user.role = "admin"
        database.add(user)
        database.commit()
    return _replace_user_token(database, user)


def _profile(user: AppUser) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "role": user.role,
        "has_password": bool(user.password_hash),
    }


@api.get("/auth/me")
def auth_me(user: User):
    return _profile(user)


@api.patch("/auth/me")
def update_auth_me(body: UserProfileUpdate, user: User, database: DB):
    if user.email == "demo@pitchcoach.local":
        raise ApiError(403, "shared_account_readonly", "The shared demo account profile cannot be changed.")

    username = _normalized_username(body.username)
    duplicate = database.exec(
        select(AppUser).where(func.lower(AppUser.username) == username, AppUser.id != user.id)
    ).first()
    if duplicate:
        raise ApiError(409, "username_taken", "This username is already taken.")

    user.username = username
    database.add(user)
    database.commit()
    database.refresh(user)
    return _profile(user)


@api.post("/auth/me/password", status_code=204)
def change_password(
    body: PasswordChange,
    user: User,
    database: DB,
    x_access_token: Annotated[str, Header()],
):
    if user.email == "demo@pitchcoach.local":
        raise ApiError(403, "shared_account_readonly", "The shared demo account profile cannot be changed.")
    # 400, not 401: the web app signs the user out on any 401.
    if user.password_hash and not verify_password(body.current_password or "", user.password_hash):
        raise ApiError(400, "wrong_password", "The current password is incorrect.")
    if user.password_hash and verify_password(body.new_password, user.password_hash):
        raise ApiError(422, "same_password", "Choose a password different from the current one.")

    user.password_hash = hash_password(body.new_password)
    # Sign out every other device; the token that made this request keeps working.
    current = _hash(x_access_token)
    for extra in database.exec(select(AccessToken).where(AccessToken.user_id == user.id)).all():
        if extra.token_hash != current:
            database.delete(extra)
    if user.token_hash != current:
        user.token_hash = _hash(secrets.token_urlsafe(32))
    database.add(user)
    database.commit()
    return Response(status_code=204)


@api.put("/auth/me/avatar", status_code=204)
async def update_profile_avatar(user: User, database: DB, file: UploadFile):
    if user.email == "demo@pitchcoach.local":
        raise ApiError(403, "shared_account_readonly", "The shared demo account profile cannot be changed.")

    content = await file.read(PROFILE_AVATAR_MAX_BYTES + 1)
    image = _profile_avatar_webp(content)
    object_key = f"user-avatars/{user.id}.webp"

    if db.shared_storage_enabled():
        try:
            storage.upload_bytes(object_key, image, "image/webp", upsert=True)
        except storage.StorageError as exc:
            raise _storage_failure(exc) from exc
        user.avatar_key = storage.uri_for(object_key)
    else:
        destination = config.DATA_DIR / "user-avatars" / f"{user.id}.webp"
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(image)
        except OSError as exc:
            log.error("Could not save profile image: %s", exc)
            raise ApiError(503, "storage_unavailable", "Profile image storage is unavailable.") from exc
        user.avatar_key = f"local://{object_key}"

    database.add(user)
    database.commit()
    return Response(status_code=204)


@api.get("/auth/me/avatar")
def get_profile_avatar(user: User):
    if user.email == "demo@pitchcoach.local":
        try:
            content = DEMO_AVATAR_PATH.read_bytes()
        except OSError as exc:
            log.error("Could not read the built-in demo avatar: %s", exc)
            raise ApiError(503, "storage_unavailable", "Profile image storage is unavailable.") from exc
        return Response(
            content,
            media_type="image/webp",
            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        )

    if not user.avatar_key:
        # No photo yet is the normal case, not an error: answer empty so browsers don't log a failed request.
        return Response(status_code=204, headers={"Cache-Control": "private, no-store"})

    object_key = storage.key_from_uri(user.avatar_key)
    if object_key:
        try:
            content = storage.download_bytes(object_key)
        except storage.StorageNotFound as exc:
            raise ApiError(404, "avatar_not_found", "Profile image was not found.") from exc
        except storage.StorageError as exc:
            raise _storage_failure(exc) from exc
    elif user.avatar_key == f"local://user-avatars/{user.id}.webp":
        path = config.DATA_DIR / "user-avatars" / f"{user.id}.webp"
        try:
            content = path.read_bytes()
        except FileNotFoundError as exc:
            raise ApiError(404, "avatar_not_found", "Profile image was not found.") from exc
        except OSError as exc:
            raise ApiError(503, "storage_unavailable", "Profile image storage is unavailable.") from exc
    else:
        raise ApiError(404, "avatar_not_found", "Profile image was not found.")

    return Response(
        content,
        media_type="image/webp",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@api.post("/auth/logout", status_code=204)
def logout(
    user: User,
    database: DB,
    x_access_token: Annotated[str, Header()],
):
    token_hash = _hash(x_access_token)
    if user.token_hash == token_hash:
        user.token_hash = _hash(secrets.token_urlsafe(32))
        database.add(user)
    else:
        extra_token = database.get(AccessToken, token_hash)
        if extra_token and extra_token.user_id == user.id:
            database.delete(extra_token)
    database.commit()
    return Response(status_code=204)


def _admin_user_view(user: AppUser) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "role": user.role,
        "is_active": user.is_active,
        "created_at": _iso(user.created_at),
    }


@api.get("/admin/users", response_model=list[AdminUserView])
def list_users(_: AdminUser, database: DB):
    users = database.exec(select(AppUser).order_by(AppUser.created_at.desc())).all()
    return [_admin_user_view(user) for user in users]


@api.patch("/admin/users/{user_id}", response_model=AdminUserView)
def update_user_role(user_id: str, body: AdminUserUpdate, admin: AdminUser, database: DB):
    target = database.get(AppUser, user_id)
    if not target:
        raise not_found("User")
    if target.id == admin.id:
        raise ApiError(409, "self_update_forbidden", "Administrators cannot change their own role or status.")

    changes = body.model_dump(exclude_unset=True)
    next_role = changes.get("role", target.role)
    next_active = changes.get("is_active", target.is_active)
    if target.email and target.email.lower() in config.ADMIN_EMAILS and (next_role != "admin" or not next_active):
        raise ApiError(409, "configured_admin", "This administrator's role and active status are assigned through PITCH_ADMIN_EMAILS.")
    if target.role == "admin" and (next_role != "admin" or not next_active):
        other_admins = database.exec(
            select(func.count())
            .select_from(AppUser)
            .where(AppUser.role == "admin", AppUser.is_active.is_(True), AppUser.id != target.id)
        ).one()
        if other_admins == 0:
            raise ApiError(409, "last_admin", "At least one active administrator must remain.")

    was_active = target.is_active
    target.role = next_role
    target.is_active = next_active
    if was_active and not target.is_active:
        target.token_hash = _hash(secrets.token_urlsafe(32))
        for token in database.exec(select(AccessToken).where(AccessToken.user_id == target.id)).all():
            database.delete(token)
    database.add(target)
    database.commit()
    database.refresh(target)
    return _admin_user_view(target)


@api.get("/projects")
def list_projects(user: User, database: DB):
    query = select(Project).order_by(Project.updated_at.desc())
    if user.role != "admin":
        query = query.where(Project.user_id == user.id)
    projects = database.exec(query).all()
    return [_project(database, p, with_attempts=False, include_owner=user.role == "admin") for p in projects]


@api.post("/projects", status_code=201)
def create_project(body: ProjectBody, user: User, database: DB):
    p = Project(user_id=user.id, **body.model_dump())
    p.name = p.name.strip() or "Untitled project"
    database.add(p)
    database.commit()
    return _project(database, p, with_attempts=True, include_owner=user.role == "admin")


@api.get("/projects/{project_id}")
def get_project(p: OwnedProject, user: User, database: DB):
    return _project(database, p, with_attempts=True, include_owner=user.role == "admin")


@api.patch("/projects/{project_id}")
def update_project(body: ProjectPatch, p: OwnedProject, user: User, database: DB):
    changes = body.model_dump(exclude_unset=True)
    if "selected_audio_id" in changes:
        audio_id = changes.pop("selected_audio_id")
        if audio_id is not None:
            audio_session = database.get(PitchSession, audio_id)
            audio_asset = database.get(AudioAsset, audio_id)
            if not audio_session or audio_session.project_id != p.id or not audio_asset:
                raise ApiError(404, "not_found", "Audio take not found.")
        p.selected_audio_id = audio_id
    for k, v in changes.items():
        if v is None:
            continue
        setattr(p, k, v.strip() if isinstance(v, str) else v)
    if not p.name:
        p.name = "Untitled project"
    p.updated_at = utcnow()
    database.add(p)
    database.commit()
    return _project(database, p, with_attempts=True, include_owner=user.role == "admin")


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
    s.script = p.script or (previous[0].script if previous else "")
    database.add(s)
    database.flush()

    if (body is None or body.copy_inputs) and previous:
        prev = previous[0]
        s.script = p.script or prev.script
        src = _slides_path(prev)
        if db.shared_storage_enabled() and prev.slides_filename:
            source_key = _slides_object_key(prev)
            # The new attempt has no slides_filename yet; derive its storage key
            # from the source filename that is about to be copied.
            target_key = _slides_object_key(s, prev.slides_filename)
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
    s.audio_filename = Path(file.filename or f"audio{suffix}").name
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
    if db.shared_storage_enabled():
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
    if db.shared_storage_enabled():
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


@api.delete("/sessions/{session_id}/audio", status_code=204)
def delete_audio(s: Owned, database: DB):
    _not_running(s)
    asset = database.get(AudioAsset, s.id)
    if asset is None:
        return Response(status_code=204)

    local_paths: list[Path] = []
    object_keys: list[str] = []
    for value in (asset.path, asset.original_path):
        key = storage.key_from_uri(value)
        if key:
            object_keys.append(key)
        else:
            local_paths.append(Path(value))
    try:
        storage.delete_objects(object_keys)
    except storage.StorageError as exc:
        raise _storage_failure(exc) from exc

    database.delete(asset)
    db.clear_results(database, s.id)
    s.audio_filename = None
    s.status, s.stage, s.error = "created", None, None
    project = database.get(Project, s.project_id)
    if project and project.selected_audio_id == s.id:
        project.selected_audio_id = None
        database.add(project)
    database.add(s)
    database.commit()
    for path in local_paths:
        path.unlink(missing_ok=True)
    return Response(status_code=204)


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
    if db.shared_storage_enabled() and old_key and old_key != new_key:
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
    if db.shared_storage_enabled() and key:
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
    if db.shared_storage_enabled() and object_key:
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

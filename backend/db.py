"""Database tables (TDD data model plus users and projects) and helpers."""

import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import JSON, Column, inspect
from sqlmodel import Field, Session, SQLModel, create_engine, delete, select

from . import config


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return str(uuid.uuid4())


class AppUser(SQLModel, table=True):
    """Account. The browser keeps the access token; the password is stored only as a hash."""

    __tablename__ = "app_user"

    id: str = Field(default_factory=new_id, primary_key=True)
    token_hash: str = Field(index=True, unique=True)
    email: Optional[str] = Field(default=None, index=True, unique=True)
    username: Optional[str] = Field(default=None, index=True, unique=True)
    avatar_key: Optional[str] = None
    password_hash: Optional[str] = None
    role: str = "member"
    is_active: bool = True
    created_at: datetime = Field(default_factory=utcnow)


class AccessToken(SQLModel, table=True):
    """An additional token authorized for an account, such as a migrated device token."""

    __tablename__ = "access_token"

    token_hash: str = Field(primary_key=True)
    user_id: str = Field(index=True, foreign_key="app_user.id")
    created_at: datetime = Field(default_factory=utcnow)


class Project(SQLModel, table=True):
    """A folder for one pitch. Each analysis is an attempt (session) inside it."""

    __tablename__ = "project"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: str = Field(index=True, foreign_key="app_user.id")
    name: str
    goal: str = ""
    audience: str = ""
    idea: str = ""  # the pitch idea in one or two sentences
    key_points: list[str] = Field(default_factory=list, sa_column=Column(JSON))  # main points to get across
    point_slides: list[Optional[int]] = Field(default_factory=list, sa_column=Column(JSON))
    figma_url: Optional[str] = None
    script: str = ""
    selected_audio_id: Optional[str] = None
    planned_s: int = 180
    pitch_type: str = "startup"
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PitchSession(SQLModel, table=True):
    """One attempt. Project details are copied in at analysis time so history stays accurate."""

    __tablename__ = "session"

    id: str = Field(default_factory=new_id, primary_key=True)
    project_id: str = Field(index=True, foreign_key="project.id")
    title: str
    goal: str = ""
    audience: str = ""
    idea: str = ""
    key_points: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    planned_s: int
    pitch_type: str = "startup"
    script: str = ""  # what the speaker planned to say (optional)
    audio_filename: Optional[str] = None
    slides_filename: Optional[str] = None
    status: str = "created"  # created, uploaded, processing, completed, failed
    stage: Optional[str] = None  # transcribing, measuring, slides, feedback, scoring
    error: Optional[str] = None
    feedback_backend: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)


class AudioAsset(SQLModel, table=True):
    __tablename__ = "audio_asset"

    session_id: str = Field(primary_key=True, foreign_key="session.id")
    path: str  # converted 16 kHz WAV used by the pipeline
    original_path: str  # the file as uploaded, for playback
    duration_s: float
    format: str


class Slide(SQLModel, table=True):
    __tablename__ = "slide"

    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: str = Field(index=True, foreign_key="session.id")
    number: int
    text: str
    notes: str = ""
    image_only: bool = False
    numbers: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    key_terms: list[str] = Field(default_factory=list, sa_column=Column(JSON))


class Transcript(SQLModel, table=True):
    __tablename__ = "transcript"

    session_id: str = Field(primary_key=True, foreign_key="session.id")
    text: str
    sentences: list[dict[str, Any]] = Field(sa_column=Column(JSON))
    words: list[dict[str, Any]] = Field(sa_column=Column(JSON))
    language: str = "mn"


class AnalysisReport(SQLModel, table=True):
    __tablename__ = "analysis_report"

    session_id: str = Field(primary_key=True, foreign_key="session.id")
    overall: Optional[int] = None
    content: Optional[int] = None
    delivery: Optional[int] = None
    slide_alignment: Optional[int] = None
    timing: Optional[int] = None
    metrics: dict[str, Any] = Field(sa_column=Column(JSON))
    slide_results: dict[str, Any] = Field(sa_column=Column(JSON))
    feedback: dict[str, Any] = Field(sa_column=Column(JSON))
    extra: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))  # notes, wording, sub-scores
    backend: str
    created_at: datetime = Field(default_factory=utcnow)


def _engine():
    url = config.DB_URL
    if url.startswith("sqlite"):
        return create_engine(url, connect_args={"check_same_thread": False})

    # Supabase/Postgres: use the psycopg 3 driver for plain postgres:// URLs.
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg://" + url[len(prefix):]
    return create_engine(
        url,
        pool_pre_ping=True,  # hosted connections drop when idle
        # Supabase's transaction pooler (port 6543) can't use prepared statements.
        connect_args={"prepare_threshold": None},
    )


engine = _engine()


# Columns added after the first release. create_all() doesn't change existing tables, so these
# are added on startup when missing. Additive only: existing rows get the default.
ADDED_COLUMNS = {
    "app_user": {
        "email": "TEXT",
        "username": "TEXT",
        "avatar_key": "TEXT",
        "password_hash": "TEXT",
        "role": "TEXT NOT NULL DEFAULT 'member'",
        "is_active": "BOOLEAN NOT NULL DEFAULT TRUE",
    },
    "project": {
        "idea": "TEXT NOT NULL DEFAULT ''",
        "key_points": "JSON",
        "point_slides": "JSON",
        "figma_url": "TEXT",
        "script": "TEXT NOT NULL DEFAULT ''",
        "selected_audio_id": "TEXT",
    },
    "session": {"idea": "TEXT NOT NULL DEFAULT ''", "key_points": "JSON", "audio_filename": "TEXT"},
}


def _add_missing_columns() -> None:
    existing = inspect(engine)
    with engine.begin() as conn:
        for table, columns in ADDED_COLUMNS.items():
            if not existing.has_table(table):
                continue
            have = {c["name"] for c in existing.get_columns(table)}
            for name, ddl in columns.items():
                if name not in have:
                    conn.exec_driver_sql(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {ddl}')


def _ensure_unique(column: str) -> None:
    """Old databases gain `column` as a plain column. New ones already have a unique constraint."""
    insp = inspect(engine)
    insp.clear_cache()
    if not insp.has_table("app_user"):
        return
    for idx in insp.get_indexes("app_user"):
        if idx.get("unique") and column in (idx.get("column_names") or []):
            return
    for constraint in insp.get_unique_constraints("app_user"):
        if column in (constraint.get("column_names") or []):
            return
    with engine.begin() as conn:
        conn.exec_driver_sql(f'CREATE UNIQUE INDEX IF NOT EXISTS "ix_app_user_{column}" ON "app_user" ("{column}")')


def init() -> None:
    config.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    from . import storage

    shared_database = engine.dialect.name == "postgresql"
    if shared_database:
        storage.validate_configuration(required=True)
    SQLModel.metadata.create_all(engine)
    _add_missing_columns()
    _ensure_unique("email")
    _ensure_unique("username")
    if engine.dialect.name == "postgresql":
        # Supabase exposes the public schema through its REST API. With row-level security on
        # and no policies, the anon key can't read these tables; the server's own role owns
        # them and is not affected.
        with engine.begin() as conn:
            for table in SQLModel.metadata.sorted_tables:
                conn.exec_driver_sql(f'ALTER TABLE "{table.name}" ENABLE ROW LEVEL SECURITY')


def shared_storage_enabled() -> bool:
    if engine.dialect.name != "postgresql":
        return False
    from . import storage

    return storage.configured()


def session_dir(session_id: str):
    path = config.SESSIONS_DIR / session_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def clear_results(db: Session, session_id: str) -> None:
    db.exec(delete(Transcript).where(Transcript.session_id == session_id))
    db.exec(delete(AnalysisReport).where(AnalysisReport.session_id == session_id))


def delete_session(db: Session, session_id: str) -> None:
    audio = db.get(AudioAsset, session_id)
    storage_keys = []
    if audio:
        from . import storage

        storage_keys.extend(
            key for value in (audio.path, audio.original_path)
            if (key := storage.key_from_uri(value))
        )
    pitch_session = db.get(PitchSession, session_id)
    if pitch_session and pitch_session.slides_filename:
        from . import storage

        suffix = Path(pitch_session.slides_filename).suffix.lower()
        storage_keys.append(f"sessions/{session_id}/slides{suffix}")
    if storage_keys:
        storage.delete_objects(storage_keys)

    clear_results(db, session_id)
    db.exec(delete(Slide).where(Slide.session_id == session_id))
    db.exec(delete(AudioAsset).where(AudioAsset.session_id == session_id))
    db.exec(delete(PitchSession).where(PitchSession.id == session_id))
    db.commit()
    shutil.rmtree(config.SESSIONS_DIR / session_id, ignore_errors=True)


def delete_project(db: Session, project_id: str) -> None:
    for sid in db.exec(select(PitchSession.id).where(PitchSession.project_id == project_id)).all():
        delete_session(db, sid)
    db.exec(delete(Project).where(Project.id == project_id))
    db.commit()


def cleanup_old(days: int) -> int:
    """Delete projects untouched for `days`. 0 keeps everything until the user deletes it."""
    if days <= 0:
        return 0
    cutoff = utcnow() - timedelta(days=days)
    with Session(engine) as db:
        old = db.exec(select(Project.id).where(Project.updated_at < cutoff)).all()
        for pid in old:
            delete_project(db, pid)
    return len(old)

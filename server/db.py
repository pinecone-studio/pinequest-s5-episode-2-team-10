"""SQLite tables (TDD data model) and session helpers."""

import shutil
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import JSON, Column
from sqlmodel import Field, Session, SQLModel, create_engine, delete, select

from . import config


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class PitchSession(SQLModel, table=True):
    __tablename__ = "session"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    access_token_hash: str
    group_id: Optional[str] = Field(default=None, index=True)
    title: str
    goal: str = ""
    audience: str = ""
    planned_s: int
    pitch_type: str = "startup"
    status: str = "created"  # created, uploaded, processing, completed, failed
    stage: Optional[str] = None  # transcribing, measuring, slides, feedback, scoring
    error: Optional[str] = None
    feedback_backend: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)


class AudioAsset(SQLModel, table=True):
    __tablename__ = "audio_asset"

    session_id: str = Field(primary_key=True, foreign_key="session.id")
    path: str
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


engine = create_engine(config.DB_URL, connect_args={"check_same_thread": False})


def init() -> None:
    config.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(engine)


def session_dir(session_id: str):
    path = config.SESSIONS_DIR / session_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def clear_results(db: Session, session_id: str) -> None:
    db.exec(delete(Transcript).where(Transcript.session_id == session_id))
    db.exec(delete(AnalysisReport).where(AnalysisReport.session_id == session_id))


def delete_session(db: Session, session_id: str) -> None:
    clear_results(db, session_id)
    db.exec(delete(Slide).where(Slide.session_id == session_id))
    db.exec(delete(AudioAsset).where(AudioAsset.session_id == session_id))
    db.exec(delete(PitchSession).where(PitchSession.id == session_id))
    db.commit()
    shutil.rmtree(config.SESSIONS_DIR / session_id, ignore_errors=True)


def cleanup_old(days: int) -> int:
    """Delete sessions and files older than `days` (TDD privacy section)."""
    cutoff = utcnow() - timedelta(days=days)
    with Session(engine) as db:
        old = db.exec(select(PitchSession.id).where(PitchSession.created_at < cutoff)).all()
        for sid in old:
            delete_session(db, sid)
    return len(old)

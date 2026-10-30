"""One background worker: the GPU fits one analysis job at a time."""

import logging
import tempfile
import threading
from collections import deque
from pathlib import Path
from typing import Optional

from sqlmodel import Session, select

from pipeline import run
from pipeline.asr import AsrError
from pipeline.feedback import FeedbackError

from .db import AnalysisReport, AudioAsset, PitchSession, Slide, Transcript, clear_results, engine, utcnow
from . import storage

log = logging.getLogger("pitchcoach")

# Errors whose message is safe and useful to show the user as is.
USER_ERRORS = (AsrError, FeedbackError, ValueError, storage.StorageError)



MAX_PREVIOUS_TAKES = 2


def previous_takes(db: Session, s: PitchSession, audio: AudioAsset) -> list[dict]:
    """The speaker's earlier analysed takes of this pitch, newest first, as a short summary for the model.

    Analysing the same recording again is not an earlier take, so a session with the same file name
    and length is skipped.
    """
    rows = db.exec(
        select(PitchSession, AnalysisReport, AudioAsset)
        .join(AnalysisReport, AnalysisReport.session_id == PitchSession.id)
        .join(AudioAsset, AudioAsset.session_id == PitchSession.id, isouter=True)
        .where(
            PitchSession.project_id == s.project_id,
            PitchSession.id != s.id,
            PitchSession.status == "completed",
            PitchSession.created_at < s.created_at,
        )
        .order_by(PitchSession.created_at.desc())
    ).all()
    out: list[dict] = []
    for earlier, report, earlier_audio in rows:
        same_recording = (
            earlier.audio_filename == s.audio_filename
            and earlier_audio is not None
            and abs((earlier_audio.duration_s or 0) - (audio.duration_s or 0)) < 0.05
        )
        if same_recording:
            continue
        fb = report.feedback or {}
        metrics = report.metrics or {}
        points = (fb.get("main_points") or {}).get("points") or []
        out.append({
            "date": earlier.created_at.date().isoformat(),
            "fixes": [r["problem"] for r in (fb.get("recommendations") or [])[:3] if r.get("problem")],
            "main_points": [
                {"text": p.get("text", ""), "status": p.get("status") if p.get("verified", True) else "missed"}
                for p in points
            ],
            "wpm": metrics.get("wpm"),
            "fillers_per_100": metrics.get("fillers_per_100"),
        })
        if len(out) == MAX_PREVIOUS_TAKES:
            break
    return out


class Worker:
    def __init__(self) -> None:
        self._queue: deque[str] = deque()
        self._cv = threading.Condition()
        self.current: Optional[str] = None
        self._thread = threading.Thread(target=self._loop, name="analysis-worker", daemon=True)

    def start(self) -> None:
        self._requeue_unfinished()
        self._thread.start()

    def enqueue(self, session_id: str) -> int:
        with self._cv:
            if session_id not in self._queue and session_id != self.current:
                self._queue.append(session_id)
                self._cv.notify()
            return self.position(session_id) or 0

    def position(self, session_id: str) -> Optional[int]:
        """0 while running, n when n jobs are ahead in line, None when not queued."""
        if session_id == self.current:
            return 0
        try:
            return self._queue.index(session_id) + (1 if self.current else 0)
        except ValueError:
            return None

    def remove(self, session_id: str) -> None:
        with self._cv:
            if session_id in self._queue:
                self._queue.remove(session_id)

    def _requeue_unfinished(self) -> None:
        with Session(engine) as db:
            rows = db.exec(
                select(PitchSession).where(PitchSession.status == "processing").order_by(PitchSession.created_at)
            ).all()
            for s in rows:
                s.stage = None
                db.add(s)
                self._queue.append(s.id)
            db.commit()

    def _loop(self) -> None:
        while True:
            with self._cv:
                while not self._queue:
                    self._cv.wait()
                self.current = self._queue.popleft()
            try:
                self._process(self.current)
            except Exception:
                log.exception("Worker crashed on %s", self.current)
            finally:
                self.current = None

    def _set(self, session_id: str, **fields) -> None:
        with Session(engine) as db:
            s = db.get(PitchSession, session_id)
            if s:
                for k, v in fields.items():
                    setattr(s, k, v)
                db.add(s)
                db.commit()

    def _process(self, session_id: str) -> None:
        with Session(engine) as db:
            s = db.get(PitchSession, session_id)
            audio = db.get(AudioAsset, session_id)
            if not s or not audio:
                return
            slides = db.exec(select(Slide).where(Slide.session_id == session_id).order_by(Slide.number)).all()
            session_info = {
                "title": s.title,
                "goal": s.goal,
                "audience": s.audience,
                "planned_s": s.planned_s,
                "pitch_type": s.pitch_type,
                "script": s.script,
                "idea": s.idea,
                "key_points": list(s.key_points or []),
                "previous_takes": previous_takes(db, s, audio),
            }
            slide_data = [
                {"number": sl.number, "text": sl.text, "notes": sl.notes, "image_only": sl.image_only,
                 "numbers": sl.numbers, "key_terms": sl.key_terms}
                for sl in slides
            ]
            backend = s.feedback_backend
            audio_path, duration = audio.path, audio.duration_s

        log.info("Analyzing %s with %s", session_id, backend)
        try:
            object_key = storage.key_from_uri(audio_path)
            if object_key:
                with tempfile.TemporaryDirectory(prefix="saylo-analysis-") as temp_dir:
                    wav = Path(temp_dir) / "audio.wav"
                    wav.write_bytes(storage.download_bytes(object_key))
                    result = run.analyze(
                        wav, duration, session_info, slide_data, backend,
                        on_stage=lambda stage: self._set(session_id, stage=stage),
                    )
            else:
                result = run.analyze(
                    Path(audio_path), duration, session_info, slide_data, backend,
                    on_stage=lambda stage: self._set(session_id, stage=stage),
                )
        except USER_ERRORS as e:
            self._set(session_id, status="failed", stage=None, error=str(e))
            return
        except Exception:
            log.exception("Analysis failed for %s", session_id)
            self._set(session_id, status="failed", stage=None, error="Analysis failed on the server.")
            return

        # The report names the model that actually wrote the feedback (it may have fallen back).
        self._save(session_id, result.get("feedback_backend", backend), result)

    def _save(self, session_id: str, backend: str, r: dict) -> None:
        with Session(engine) as db:
            s = db.get(PitchSession, session_id)
            if not s:  # deleted while running
                return
            clear_results(db, session_id)
            db.add(Transcript(
                session_id=session_id,
                text=" ".join(x["text"] for x in r["sentences"]),
                sentences=r["sentences"],
                words=r["words"],
            ))
            sc = r["scores"]
            db.add(AnalysisReport(
                session_id=session_id,
                overall=sc["overall"],
                content=sc["content"],
                delivery=sc["delivery"],
                slide_alignment=sc["slide_alignment"],
                timing=sc["timing"],
                metrics=r["metrics"],
                slide_results=r["alignment"],
                feedback=r["feedback"],
                extra={
                    "categories_used": sc["categories_used"],
                    "delivery_parts": sc["delivery_parts"],
                    "wording": r["wording"],
                    "notes": r["notes"],
                    "asr_backend": r["asr_backend"],
                    "delivery_checks": r.get("delivery", {}),
                    "fallbacks": r.get("fallbacks", []),
                },
                backend=backend,
                created_at=utcnow(),
            ))
            s.status, s.stage, s.error = "completed", None, None
            db.add(s)
            db.commit()


worker = Worker()

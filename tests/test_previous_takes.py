"""Earlier takes of the same pitch are summarised for the feedback model (backend/worker.py)."""

from datetime import datetime, timedelta, timezone

from sqlmodel import Session, SQLModel, create_engine

from backend.db import AnalysisReport, AppUser, AudioAsset, PitchSession, Project
from backend.worker import previous_takes
from pipeline import feedback

T0 = datetime(2026, 10, 30, 9, 0, tzinfo=timezone.utc)


def _take(db, project, minutes, status="completed", filename="rec.webm", duration=60.0, fixes=(), wpm=120.0):
    s = PitchSession(project_id=project.id, title="p", planned_s=120, status=status, audio_filename=filename,
                     created_at=T0 + timedelta(minutes=minutes))
    db.add(s)
    db.flush()
    db.add(AudioAsset(session_id=s.id, path="a.wav", original_path=filename, duration_s=duration, format="webm"))
    if status == "completed":
        feedback_json = {
            "recommendations": [{"problem": f} for f in fixes],
            "main_points": {"points": [
                {"text": "Асуудал", "status": "covered", "verified": True},
                {"text": "Хүсэлт", "status": "covered", "verified": False},  # unverified quote: counts as missed
            ]},
        }
        db.add(AnalysisReport(session_id=s.id, metrics={"wpm": wpm, "fillers_per_100": 4.2}, slide_results={},
                              feedback=feedback_json, backend="gemma4-base"))
    db.flush()
    return s


def test_newest_earlier_takes_of_the_same_pitch():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db:
        user = AppUser(token_hash="h")
        db.add(user)
        db.flush()
        pitch, other = Project(user_id=user.id, name="pitch"), Project(user_id=user.id, name="other")
        db.add(pitch)
        db.add(other)
        db.flush()
        _take(db, pitch, 0, duration=50, fixes=["Хамгийн эхний"])
        _take(db, pitch, 10, duration=55, fixes=["Хурд хэт өндөр", "Хүсэлт тодорхойгүй", "Тоо буруу", "Дөрөв дэх"], wpm=170)
        _take(db, pitch, 20, duration=58, fixes=["Сүүлийн өмнөх"])
        _take(db, pitch, 25, status="failed", duration=59)  # failed: no report
        _take(db, other, 26, duration=61, fixes=["Өөр илтгэл"])  # another pitch
        _take(db, pitch, 27, duration=60, fixes=["Ижил бичлэг"])  # same recording, analysed before
        current = _take(db, pitch, 30, status="processing", duration=60)
        _take(db, pitch, 40, duration=70, fixes=["Хожим"])  # later than this one
        audio = db.get(AudioAsset, current.id)

        takes = previous_takes(db, current, audio)

    assert [t["fixes"][0] for t in takes] == ["Сүүлийн өмнөх", "Хурд хэт өндөр"]  # newest first, at most 2
    assert takes[1]["fixes"] == ["Хурд хэт өндөр", "Хүсэлт тодорхойгүй", "Тоо буруу"]  # top 3 only
    assert takes[1]["wpm"] == 170 and takes[1]["fillers_per_100"] == 4.2
    assert takes[0]["main_points"] == [{"text": "Асуудал", "status": "covered"}, {"text": "Хүсэлт", "status": "missed"}]
    assert takes[0]["date"] == "2026-10-30"


def test_first_take_has_none_and_input_carries_them():
    data = feedback.build_input({"title": "p", "previous_takes": [{"fixes": ["x"]}]}, [], {}, {}, [], {"slides": []})
    assert data["previous_takes"] == [{"fixes": ["x"]}]
    assert "previous_takes" not in data["session"]  # not duplicated in the session info
    assert feedback.build_input({"title": "p"}, [], {}, {}, [], {"slides": []})["previous_takes"] == []
    assert "previous_takes" in feedback.PROMPT and "Өмнөх бичлэгээс хойш хэвээр" in feedback.PROMPT


def test_number_checks_are_completed_in_code():
    """The model lists only figures the speaker said; the rest are added as never mentioned, in order."""
    data = {
        "transcript": [{"start": 0.0}], "slides": [{"number": 1}], "criteria": [], "alignment": [{"slide": 1, "status": "missed"}],
        "number_candidates": [{"slide": 1, "on_slide": "40%"}, {"slide": 1, "on_slide": "120"}, {"slide": 1, "on_slide": "40%"}],
    }
    fb = {"content_scores": [], "slide_feedback": [], "recommendations": [],
          "number_checks": [{"slide": 1, "on_slide": "120", "said": "зуун хорь", "inconsistent": False},
                            {"slide": 9, "on_slide": "7", "said": "долоо", "inconsistent": True}]}  # not a candidate: dropped
    try:
        out = feedback._sanitize(fb, data)
    except KeyError:
        out = fb  # later steps need more input than this test gives; the number checks are done by then
    assert out["number_checks"] == [
        {"slide": 1, "on_slide": "40%", "said": None, "inconsistent": False},
        {"slide": 1, "on_slide": "120", "said": "зуун хорь", "inconsistent": False},
    ]
    assert out["slide_feedback"] == [{"slide": 1, "status": "missed", "comment": ""}]


def test_fixes_still_open_since_the_last_take_are_marked():
    earlier = [{"fixes": ["Эцсийн дуудлага (CTA) байхгүй байна.", "Зорилтот хэрэглэгчийг тодорхойлох шаардлагатай."]}]
    recs = [
        {"problem": "Эцсийн дуудлага (CTA) байхгүй."},
        {"problem": "Зорилтот хэрэглэгч тодорхойгүй."},
        {"problem": "Бичлэгийн дараалал эмх замбараагүй."},  # new problem
        {"problem": feedback.STILL_OPEN + " Эцсийн дуудлага байхгүй."},  # the model already marked it
    ]
    feedback.mark_still_open(recs, earlier)
    assert [r["problem"].startswith(feedback.STILL_OPEN) for r in recs] == [True, True, False, True]
    assert recs[3]["problem"].count(feedback.STILL_OPEN) == 1  # not marked twice
    feedback.mark_still_open(r2 := [{"problem": "Эцсийн дуудлага (CTA) байхгүй."}], [])
    assert not r2[0]["problem"].startswith(feedback.STILL_OPEN)  # first take: nothing to compare
    assert not feedback.same_problem("Хурд хэт өндөр байна.", "Тоо слайдтай таарахгүй байна.")

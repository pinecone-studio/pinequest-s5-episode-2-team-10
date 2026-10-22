"""Main points check: quote verification, coverage, off-topic flags and the key-word fallback."""

from pipeline import feedback, points, text_checks

SENTENCES = [
    {"text": "Оюутнууд илтгэл тавихаас өмнө дадлага хийх боломж бага байдаг.", "start": 0.0, "end": 4.0},
    {"text": "Манай апп илтгэлийг бичээд нэг минутад зөвлөгөө өгнө.", "start": 4.5, "end": 8.0},
    {"text": "Өчигдөр би кино үзсэн.", "start": 8.5, "end": 10.0},
]
POINTS = [
    "Оюутнууд илтгэлээ дадлагажуулах боломж бага",
    "Апп нэг минутад зөвлөгөө өгнө",
    "Эхний жилд 1000 хэрэглэгч",
]


def _verify(checks, off_topic=(), comment=""):
    return points.verify(list(checks), POINTS, SENTENCES, list(off_topic), comment, "llm")


def test_clean_points_trims_and_caps():
    raw = ["  a  b ", "", 3, "c" * 300] + [f"p{i}" for i in range(10)]
    out = points.clean_points(raw)
    assert out[0] == "a b"
    assert len(out[1]) == points.MAX_POINT_CHARS
    assert len(out) == points.MAX_POINTS
    assert points.clean_points("not a list") == []


def test_quoted_points_are_verified_and_scored():
    r = _verify([
        {"point": 0, "status": "covered", "evidence": "илтгэл тавихаас өмнө дадлага хийх боломж бага байдаг", "note": ""},
        {"point": 1, "status": "partial", "evidence": "Манай апп илтгэлийг бичээд", "note": "Хурдыг тодорхой хэл."},
        {"point": 2, "status": "missed", "evidence": "", "note": "Тоо хэлээгүй."},
    ])
    assert [p["status"] for p in r["points"]] == ["covered", "partial", "missed"]
    assert all(p["verified"] for p in r["points"])
    assert r["coverage"] == 50  # (1 + 0.5 + 0) / 3


def test_invented_quote_is_unverified_and_scores_zero():
    r = _verify([
        {"point": 0, "status": "covered", "evidence": "Бид 1000 хэрэглэгчтэй болно", "note": ""},
    ])
    first = r["points"][0]
    assert first["status"] == "covered" and first["verified"] is False and first["evidence"] == ""
    assert r["coverage"] == 0


def test_quote_may_span_sentences_and_ignore_punctuation():
    r = _verify([{"point": 0, "status": "covered", "evidence": "боломж бага байдаг Манай апп", "note": ""}])
    assert r["points"][0]["verified"]


def test_missing_and_duplicate_points_and_bad_ids():
    r = _verify([
        {"point": 1, "status": "covered", "evidence": "нэг минутад зөвлөгөө өгнө", "note": ""},
        {"point": 1, "status": "missed", "evidence": "", "note": "duplicate is ignored"},
        {"point": 9, "status": "covered", "evidence": "x", "note": ""},
    ])
    assert [p["status"] for p in r["points"]] == ["missed", "covered", "missed"]
    assert r["coverage"] == 33


def test_off_topic_keeps_real_sentences_and_quotes_them_from_code():
    r = _verify([], off_topic=[
        {"sentence_id": 2, "reason": "Төсөлтэй холбоогүй."},
        {"sentence_id": 2, "reason": "duplicate"},
        {"sentence_id": 7, "reason": "no such sentence"},
    ])
    assert len(r["off_topic"]) == 1
    assert r["off_topic"][0]["text"] == SENTENCES[2]["text"] and r["off_topic"][0]["start"] == 8.5


def test_no_points_means_no_coverage():
    r = points.verify([], [], SENTENCES, [], "", "llm")
    assert r["coverage"] is None and r["points"] == []


def test_rules_check_matches_key_words_across_suffixes():
    checks = points.rules_check(POINTS, SENTENCES)
    status = [c["status"] for c in checks]
    assert status[0] in ("covered", "partial")
    assert status[1] == "covered"
    assert status[2] == "missed" and checks[2]["evidence"] == ""
    # Evidence from rules is real transcript text, so it always verifies.
    r = points.verify(checks, POINTS, SENTENCES, [], "", "words")
    assert all(p["verified"] for p in r["points"])


# ---- Through the feedback step ----------------------------------------------


def _data(key_points=POINTS, idea="Илтгэлийн дасгалжуулагч апп"):
    session = {"title": "t", "pitch_type": "startup", "planned_s": 60, "idea": idea, "key_points": key_points}
    return feedback.build_input(
        session, SENTENCES, {"wpm": 140}, text_checks.check(SENTENCES), [], {"slides": [], "number_candidates": []}
    )


def test_input_carries_pitch_but_not_in_session_info():
    data = _data()
    assert data["pitch"]["idea"] == "Илтгэлийн дасгалжуулагч апп"
    assert [p["id"] for p in data["pitch"]["key_points"]] == [0, 1, 2]
    assert "key_points" not in data["session"] and "idea" not in data["session"]


def test_model_output_goes_through_verification(monkeypatch):
    out = {
        "summary": "s", "strengths": [], "content_scores": [], "slide_feedback": [], "number_checks": [],
        "recommendations": [], "filler_occurrences": [],
        "point_checks": [
            {"point": 0, "status": "covered", "evidence": "дадлага хийх боломж бага", "note": ""},
            {"point": 1, "status": "covered", "evidence": "AI invented this", "note": ""},
            {"point": 2, "status": "missed", "evidence": "", "note": ""},
        ],
        "off_topic": [{"sentence_id": 2, "reason": "Хувийн яриа."}],
        "idea_comment": "Санаа ойлгомжтой.",
    }
    monkeypatch.setattr(feedback, "_claude", lambda d: out)
    mp = feedback.generate("claude", _data())["main_points"]
    assert mp["method"] == "llm"
    assert [p["verified"] for p in mp["points"]] == [True, False, True]
    assert mp["coverage"] == 33
    assert mp["off_topic"][0]["sentence_id"] == 2
    assert mp["idea_comment"] == "Санаа ойлгомжтой."


def test_rules_backend_fills_main_points():
    mp = feedback.generate("rules", _data())["main_points"]
    assert mp["method"] == "words"
    assert len(mp["points"]) == 3 and mp["coverage"] is not None


def test_without_points_report_has_empty_main_points():
    mp = feedback.generate("rules", _data(key_points=[], idea=""))["main_points"]
    assert mp["points"] == [] and mp["coverage"] is None and mp["idea_comment"] == ""

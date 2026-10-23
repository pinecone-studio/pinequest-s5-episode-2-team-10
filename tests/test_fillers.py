"""Filler detection: list candidates, verification of model output, summary and scoring."""

import pytest

from pipeline import feedback, fillers, scoring, text_checks

SENTENCES = [
    {"text": "Ээ, бид тэгээд тэгээд шинэ апп хийсэн.", "start": 0.0, "end": 3.0},
    {"text": "Тэгээд бид нөгөө зах зээл рүү гарна, аан.", "start": 3.2, "end": 6.0},
    {"text": "Миний ээж бас ээ дэмжсэн, ээ.", "start": 6.5, "end": 9.0},
]
WORD_COUNT = 21


# ---- List candidates --------------------------------------------------------


def test_candidates_whole_words_and_phrases_first():
    found = fillers.find_candidates(SENTENCES)
    assert {"sentence_id": 0, "word": "тэгээд тэгээд"} in found
    # The phrase wins: the single "тэгээд" inside it is not counted again.
    assert not any(c == {"sentence_id": 0, "word": "тэгээд"} for c in found)
    # "ээж" (mother) is not the filler "ээ".
    assert [c["word"] for c in found if c["sentence_id"] == 2] == ["ээ", "ээ"]


def test_candidates_ignore_case_and_punctuation():
    found = fillers.find_candidates([{"text": "АаН... НӨГӨӨ!", "start": 0}])
    assert [c["word"] for c in found] == ["аан", "нөгөө"]


def test_text_checks_use_the_same_list():
    w = text_checks.check(SENTENCES)
    assert w["filler_total"] == len(fillers.find_candidates(SENTENCES))
    assert w["fillers"]["ээ"] == 3


# ---- Verifying model output -------------------------------------------------


def test_verify_drops_invented_occurrences():
    model = [
        {"sentence_id": 0, "word": "ээ"},  # real
        {"sentence_id": 0, "word": "аан"},  # not in sentence 0
        {"sentence_id": 9, "word": "ээ"},  # no such sentence
        {"sentence_id": -1, "word": "ээ"},  # bad id
        {"sentence_id": "1", "word": "аан"},  # id must be an int
        {"sentence_id": 1, "word": ""},  # empty
    ]
    assert fillers.verify(model, SENTENCES) == [{"sentence_id": 0, "word": "ээ"}]


def test_verify_caps_count_at_real_occurrences():
    model = [{"sentence_id": 2, "word": "ээ"}] * 5  # sentence 2 has "ээ" twice
    assert len(fillers.verify(model, SENTENCES)) == 2


def test_verify_normalizes_case_and_punctuation():
    model = [{"sentence_id": 1, "word": "Аан."}, {"sentence_id": 1, "word": "НӨГӨӨ"}]
    assert fillers.verify(model, SENTENCES) == [
        {"sentence_id": 1, "word": "аан"},
        {"sentence_id": 1, "word": "нөгөө"},
    ]


def test_verify_rejects_long_phrases():
    model = [{"sentence_id": 1, "word": "Тэгээд бид нөгөө зах зээл"}]
    assert fillers.verify(model, SENTENCES) == []


def test_verify_accepts_fillers_missing_from_the_list():
    # A sentence-opening "Тэгээд" isn't a list candidate, but the model may judge it a filler.
    assert fillers.verify([{"sentence_id": 1, "word": "тэгээд"}], SENTENCES) == [{"sentence_id": 1, "word": "тэгээд"}]


# ---- Summary ----------------------------------------------------------------


def test_summary_counts_and_evidence():
    occ = [{"sentence_id": 0, "word": "ээ"}, {"sentence_id": 2, "word": "ээ"}, {"sentence_id": 2, "word": "ээ"},
           {"sentence_id": 1, "word": "аан"}]
    s = fillers.summarize(occ, SENTENCES, WORD_COUNT, "llm")
    assert s["total"] == 4
    assert s["per_100"] == round(4 / WORD_COUNT * 100, 2)
    assert s["words"][0]["word"] == "ээ" and s["words"][0]["count"] == 3
    assert s["words"][0]["evidence"] == [SENTENCES[0]["text"], SENTENCES[2]["text"]]
    assert [o["start_s"] for o in s["words"][0]["occurrences"]] == [0.0, 6.5, 6.5]
    assert s["note"] is None


def test_summary_with_no_fillers_warns_about_asr():
    s = fillers.summarize([], SENTENCES, WORD_COUNT, "llm")
    assert s["total"] == 0 and s["per_100"] == 0
    assert "Speech recognition" in s["note"]


def test_summary_with_no_words_has_no_rate():
    s = fillers.summarize([], [], 0, "llm")
    assert s["per_100"] is None and s["note"] is None


# ---- Through the feedback step ----------------------------------------------


def _data():
    wording = text_checks.check(SENTENCES)
    return feedback.build_input(
        {"title": "t", "pitch_type": "startup", "planned_s": 60},
        SENTENCES, {"wpm": 140}, wording, [], {"slides": [], "number_candidates": []},
    )


def _model_output(occurrences):
    return {
        "summary": "s", "strengths": [], "content_scores": [], "slide_feedback": [],
        "number_checks": [], "recommendations": [], "filler_occurrences": occurrences,
        "point_checks": [], "off_topic": [], "idea_comment": "",
    }


def test_model_output_is_verified(monkeypatch):
    model = [
        {"sentence_id": 0, "word": "ээ"},
        {"sentence_id": 0, "word": "тэгээд тэгээд"},
        {"sentence_id": 1, "word": "ээ"},  # invented: not in sentence 1
    ]
    monkeypatch.setattr(feedback, "_claude", lambda data: _model_output(model))
    fb = feedback.generate("claude", _data())
    assert fb["fillers"]["method"] == "llm"
    assert fb["fillers"]["total"] == 2
    assert fb["fillers"]["model_reported"] == 3  # one invented occurrence was dropped
    assert {w["word"] for w in fb["fillers"]["words"]} == {"ээ", "тэгээд тэгээд"}


def test_model_can_reject_list_candidates(monkeypatch):
    # The model decides "нөгөө" in sentence 1 points to something ("that market"), so it is not a filler.
    data = _data()
    kept = [c for c in data["filler_candidates"] if c["word"] != "нөгөө"]
    monkeypatch.setattr(feedback, "_claude", lambda d: _model_output(kept))
    fb = feedback.generate("claude", data)
    assert "нөгөө" not in {w["word"] for w in fb["fillers"]["words"]}
    assert fb["fillers"]["total"] == len(data["filler_candidates"]) - 1


def test_missing_filler_field_is_a_schema_error(monkeypatch):
    out = _model_output([])
    del out["filler_occurrences"]
    monkeypatch.setattr(feedback, "_claude", lambda d: out)
    with pytest.raises(feedback.FeedbackError):
        feedback.generate("claude", _data())


def test_rules_backend_counts_every_listed_filler():
    data = _data()
    fb = feedback.generate("rules", data)
    assert fb["fillers"]["method"] == "list"
    assert fb["fillers"]["total"] == len(data["filler_candidates"])


# ---- Scoring ----------------------------------------------------------------


@pytest.mark.parametrize("per_100, expected", [(0.5, 100), (1.0, 100), (3.5, 50), (6.0, 0), (9.0, 0)])
def test_filler_subscore(per_100, expected):
    parts = scoring.delivery_parts({}, {"fillers_per_100": per_100})
    assert parts["fillers"] == expected

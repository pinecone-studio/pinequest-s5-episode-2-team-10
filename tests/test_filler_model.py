"""Filler classifier wiring: marks to occurrences, the voice server reply, fallback, and the feedback hand-off."""

import httpx
import pytest
from fastapi.testclient import TestClient

from pipeline import config, feedback, filler_model

SENTENCES = [
    {"text": "Ээ, юу гэдэг юм, бид тэгээд явсан.", "start": 0.0, "end": 3.0},
    {"text": "Ээ ээ баярлалаа.", "start": 3.5, "end": 5.0},
]


def test_marked_runs_keep_listed_phrases_whole():
    # ээ | юу гэдэг юм | бид | тэгээд | явсан  — the real "тэгээд" is not marked
    found = filler_model.to_occurrences(SENTENCES, [[0, 1, 2, 3], [0, 1]])
    assert found == [
        {"sentence_id": 0, "word": "ээ"},
        {"sentence_id": 0, "word": "юу гэдэг юм"},
        {"sentence_id": 1, "word": "ээ"},
        {"sentence_id": 1, "word": "ээ"},
    ]


def test_marked_positions_out_of_range_are_ignored():
    assert filler_model.to_occurrences(SENTENCES, [[99], []]) == []


def test_parse_marks_checks_the_reply_shape():
    assert filler_model.parse_marks({"marked": [[0], []]}, 2) == [[0], []]
    for bad in ({"marked": [[0]]}, {"marked": [[True], []]}, {"marked": "x"}, []):
        with pytest.raises(filler_model.FillerModelError):
            filler_model.parse_marks(bad, 2)


def test_off_by_default(monkeypatch):
    monkeypatch.setattr(config, "FILLER_MODEL", "")
    assert filler_model.find(SENTENCES) is None


def test_remote_failure_falls_back(monkeypatch):
    monkeypatch.setattr(config, "FILLER_MODEL", "remote")

    def down(*_a, **_k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(filler_model.httpx, "post", down)
    assert filler_model.find(SENTENCES) is None


def test_remote_reply_becomes_occurrences(monkeypatch):
    monkeypatch.setattr(config, "FILLER_MODEL", "remote")
    monkeypatch.setattr(filler_model.httpx, "post",
                        lambda *_a, **_k: httpx.Response(200, json={"marked": [[0], [0, 1]]}))
    assert [o["word"] for o in filler_model.find(SENTENCES)] == ["ээ", "ээ", "ээ"]


def _data():
    sentences = [{"text": "Ээ бид тэгээд явсан.", "start": 0.0, "end": 2.0},
                 {"text": "Тэгээд тэгээд баярлалаа.", "start": 2.5, "end": 4.0},
                 {"text": "Нөгөө төсөл амжилттай.", "start": 4.5, "end": 6.0}]
    from pipeline import alignment, text_checks
    metrics = {"duration_s": 6.0, "wpm": None, "long_pauses_per_min": None, "pitch_range_st": None,
               "end_volume_drop_db": None}
    session = {"title": "t", "goal": "", "audience": "шүүгчид", "planned_s": 60, "pitch_type": "startup"}
    return feedback.build_input(session, sentences, metrics, text_checks.check(sentences), [], alignment.align(sentences, []))


def test_classifier_decides_fillers_when_on(monkeypatch):
    monkeypatch.setattr(filler_model, "find", lambda _s: [{"sentence_id": 0, "word": "ээ"}])
    fb = feedback.generate("rules", _data())
    assert fb["fillers"]["method"] == "model"
    assert fb["fillers"]["total"] == 1  # the list would also have counted "тэгээд тэгээд"
    assert fb["main_points"]["method"] == "words"


def test_without_classifier_rules_use_the_list(monkeypatch):
    monkeypatch.setattr(filler_model, "find", lambda _s: None)
    fb = feedback.generate("rules", _data())
    assert fb["fillers"]["method"] == "list"


def test_classifier_output_is_still_verified(monkeypatch):
    # A word that isn't in the sentence is dropped, as for any model.
    monkeypatch.setattr(filler_model, "find", lambda _s: [{"sentence_id": 0, "word": "аан"}])
    assert feedback.generate("rules", _data())["fillers"]["total"] == 0


@pytest.fixture
def voice(monkeypatch):
    from voice import server
    monkeypatch.setattr(server, "TOKEN", "t")
    return server, TestClient(server.app), {"Authorization": "Bearer t"}


def test_voice_fillers_endpoint_needs_token_and_model(voice, monkeypatch):
    server, client, auth = voice
    assert client.post("/v1/fillers", json={"sentences": ["ээ"]}).status_code == 401
    monkeypatch.setattr(server, "FILLER_MODEL_PATH", "")
    r = client.post("/v1/fillers", json={"sentences": ["ээ"]}, headers=auth)
    assert r.status_code == 503 and r.json()["code"] == "filler_model_off"


def test_voice_fillers_endpoint_returns_marks(voice, monkeypatch):
    server, client, auth = voice
    monkeypatch.setattr(server, "FILLER_MODEL_PATH", "/models/fillers")
    monkeypatch.setattr(server.filler_model, "mark", lambda texts, _p: [[0] for _ in texts])
    r = client.post("/v1/fillers", json={"sentences": ["ээ бид", "аан"]}, headers=auth)
    assert r.status_code == 200 and r.json() == {"marked": [[0], [0]]}

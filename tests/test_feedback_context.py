"""Gemma's context window is sized to the prompt, and a cut-off answer gives a clear error."""

import httpx
import pytest

from pipeline import feedback


def test_small_prompt_keeps_the_default_window():
    assert feedback.num_ctx_for(3_000) == 8192


def test_long_prompt_gets_room_for_the_answer():
    # The 23-slide Mongolian pitch that failed: 22,053 prompt characters (7,962 tokens).
    ctx = feedback.num_ctx_for(22_053)
    assert ctx >= 7_962 + 5_177  # prompt + the answer it actually wrote
    assert ctx % 2048 == 0


def test_window_never_exceeds_the_limit():
    assert feedback.num_ctx_for(500_000, limit=24_576) == 24_576


def _fake_post(body):
    def post(url, json, headers, timeout):
        post.sent = json
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))
    return post


def _data():
    return {"pitch": {}, "transcript": [], "metrics": {}, "wording": {}, "slides": []}


def test_cut_off_answer_says_so(monkeypatch):
    monkeypatch.setattr(feedback, "_user_message", lambda data: "x" * 20_000)
    post = _fake_post({"done_reason": "length", "message": {"content": '{"summary": "unfinish'}})
    monkeypatch.setattr(feedback.httpx, "post", post)
    with pytest.raises(feedback.FeedbackError, match="ran out of room"):
        feedback._ollama("gemma4:e4b", _data())
    assert post.sent["options"]["num_ctx"] > 8192


def test_complete_answer_is_parsed(monkeypatch):
    monkeypatch.setattr(feedback, "_user_message", lambda data: "short")
    monkeypatch.setattr(feedback.httpx, "post", _fake_post({"done_reason": "stop", "message": {"content": '{"summary": "ok"}'}}))
    assert feedback._ollama("gemma4:e4b", _data()) == {"summary": "ok"}

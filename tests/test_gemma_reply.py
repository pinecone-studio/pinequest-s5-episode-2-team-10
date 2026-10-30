"""An unreadable Gemma reply is retried once, then the fallback model writes the feedback."""

import httpx
import pytest

from pipeline import feedback


def _replies(*contents):
    """A fake httpx.post that answers with each content in turn and counts the calls."""
    def post(url, json, headers, timeout):
        content = contents[post.calls]
        post.calls += 1
        body = {"done_reason": "stop", "eval_count": 3, "prompt_eval_count": 9, "message": {"content": content}}
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))
    post.calls = 0
    return post


def _data():
    return {"pitch": {}, "transcript": [], "metrics": {}, "wording": {}, "slides": []}


def test_empty_reply_is_asked_again(monkeypatch):
    post = _replies("", '{"summary": "ok"}')
    monkeypatch.setattr(feedback.httpx, "post", post)
    assert feedback._ollama("gemma4:e4b", _data()) == {"summary": "ok"}
    assert post.calls == 2


def test_two_bad_replies_count_as_unavailable(monkeypatch, caplog):
    secret = "миний нууц яриа"
    monkeypatch.setattr(feedback.httpx, "post", _replies(secret, "not json"))
    with pytest.raises(feedback.ModelUnavailable, match="valid JSON"):
        feedback._ollama("gemma4:e4b", _data())
    assert "done_reason=stop" in caplog.text
    assert secret not in caplog.text  # the reply quotes the transcript, so it isn't logged


def test_fenced_json_is_read():
    assert feedback._find_json('```json\n{"summary": "ok"}\n```') == {"summary": "ok"}
    assert feedback._find_json('Here it is: {"a": 1} done') == {"a": 1}
    assert feedback._find_json("[1, 2]") is None
    assert feedback._find_json("") is None


def test_non_json_from_the_server_is_unavailable(monkeypatch):
    def post(url, json, headers, timeout):
        return httpx.Response(200, text="<html>login</html>", request=httpx.Request("POST", url))
    monkeypatch.setattr(feedback.httpx, "post", post)
    with pytest.raises(feedback.ModelUnavailable, match="OLLAMA_URL"):
        feedback._ollama("gemma4:e4b", _data())


def test_bad_replies_fall_back_to_the_rules(monkeypatch):
    monkeypatch.setattr(feedback.httpx, "post", _replies("", ""))
    monkeypatch.setattr(feedback, "fallback_for", lambda backend: "rules")
    monkeypatch.setattr(feedback, "generate", lambda backend, data: (
        feedback._ollama("gemma4:e4b", data) if backend.startswith("gemma4") else {"by": backend}
    ))
    fb, used, note = feedback.generate_with_fallback("gemma4-base", _data())
    assert (fb, used) == ({"by": "rules"}, "rules")
    assert "valid JSON" in note

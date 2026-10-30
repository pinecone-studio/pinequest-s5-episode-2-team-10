"""Fallbacks when the GPU PC can't be used: Duudlaga instead of the voice server, and another model
instead of Gemma (pipeline/asr.py, pipeline/feedback.py).

Run from the repository root: python -m pytest tests
"""

import wave

import httpx
import numpy as np
import pytest

from pipeline import asr, config, feedback

SR = 16000


def write_wav(path, parts):
    """parts: [(seconds, loud?)] → 16 kHz mono WAV with tone where loud, near-silence elsewhere."""
    chunks = []
    for seconds, loud in parts:
        t = np.arange(int(seconds * SR)) / SR
        chunks.append(0.3 * np.sin(2 * np.pi * 220 * t) if loud else np.full(len(t), 1e-4))
    audio = (np.concatenate(chunks) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(audio.tobytes())
    return path


class FakeClient:
    """Stands in for httpx.Client: each post() returns or raises the next reply."""

    replies: list = []

    def __init__(self, *_, **__):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def post(self, *_, **__):
        reply = FakeClient.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


@pytest.fixture
def remote(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "ASR_BACKEND", "remote")
    monkeypatch.setattr(config, "VOICE_TOKEN", "t")
    monkeypatch.setattr(config, "VOICE_URL", "http://voice.test")
    monkeypatch.setattr(asr.httpx, "Client", FakeClient)
    return write_wav(tmp_path / "a.wav", [(0.5, False), (2, True), (1.5, False), (2, True), (0.5, False)])


def test_voice_server_down_falls_back_to_duudlaga_with_a_note(remote, monkeypatch):
    monkeypatch.setattr(config, "DUUDLAGA_API_KEY", "k")
    monkeypatch.setattr(config, "ASR_FALLBACK", "duudlaga")
    # Two connection errors (the voice server retries once), then Duudlaga answers.
    FakeClient.replies = [httpx.ConnectError("down"), httpx.ConnectError("down"),
                          httpx.Response(200, json={"text": "сайн байна уу бид шинэ апп хийсэн"})]
    words, used, note = asr.transcribe_with_fallback(remote)
    assert used == "duudlaga"
    assert "Duudlaga transcribed" in note and "voice server" in note
    assert [w["word"] for w in words][:3] == ["сайн", "байна", "уу"]
    # Words are placed where the audio has sound, so the 1.5 s silence is a real pause.
    gaps = [b["start"] - a["end"] for a, b in zip(words, words[1:])]
    assert max(gaps) > 1.0


def test_no_fallback_without_a_duudlaga_key(remote, monkeypatch):
    monkeypatch.setattr(config, "DUUDLAGA_API_KEY", "")
    FakeClient.replies = [httpx.ConnectError("down"), httpx.ConnectError("down")]
    with pytest.raises(asr.VoiceUnavailable):
        asr.transcribe_with_fallback(remote)


def test_fallback_can_be_turned_off(remote, monkeypatch):
    monkeypatch.setattr(config, "DUUDLAGA_API_KEY", "k")
    monkeypatch.setattr(config, "ASR_FALLBACK", "none")
    FakeClient.replies = [httpx.Response(503), httpx.Response(503)]
    with pytest.raises(asr.VoiceUnavailable):
        asr.transcribe_with_fallback(remote)


def test_refused_token_and_gateway_errors_count_as_unavailable(remote, monkeypatch):
    monkeypatch.setattr(config, "DUUDLAGA_API_KEY", "k")
    monkeypatch.setattr(config, "ASR_FALLBACK", "duudlaga")
    # A refused token isn't retried; a gateway error is retried once.
    for voice_replies in ([httpx.Response(401)], [httpx.Response(502), httpx.Response(502)]):
        FakeClient.replies = [*voice_replies, httpx.Response(200, json={"text": "сайн байна уу"})]
        _, used, note = asr.transcribe_with_fallback(remote)
        assert used == "duudlaga" and note


def test_a_bad_recording_does_not_fall_back(remote, monkeypatch):
    monkeypatch.setattr(config, "DUUDLAGA_API_KEY", "k")
    FakeClient.replies = [httpx.Response(400, json={"message": "Audio is longer than 5 minutes."})]
    with pytest.raises(asr.AsrError) as caught:
        asr.transcribe_with_fallback(remote)
    assert not isinstance(caught.value, asr.VoiceUnavailable)
    assert "5 minutes" in str(caught.value)


def test_working_voice_server_has_no_note(remote, monkeypatch):
    FakeClient.replies = [httpx.Response(200, json={"words": [{"word": "сайн", "start": 0.5, "end": 0.9}]})]
    words, used, note = asr.transcribe_with_fallback(remote)
    assert used == "remote" and note is None and words[0]["word"] == "сайн"


# ---- Feedback model ------------------------------------------------------------------------------

def _gemma_down(*_args, **_kwargs):
    raise feedback.ModelUnavailable("Could not reach Ollama. Is it running on this machine?")


def test_gemma_down_falls_back_and_says_so(monkeypatch):
    monkeypatch.setattr(feedback, "generate", lambda backend, data: (_gemma_down() if backend.startswith("gemma") else {"from": backend}))
    monkeypatch.setattr(config, "FEEDBACK_FALLBACK", "auto")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    fb, used, note = feedback.generate_with_fallback("gemma4-base", {})
    assert used == "rules" and fb == {"from": "rules"}
    assert "Gemma couldn't be used" in note and "without a model" in note

    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    fb, used, note = feedback.generate_with_fallback("gemma4-base", {})
    assert used == "claude" and "Claude" in note


def test_no_fallback_when_turned_off_or_for_other_errors(monkeypatch):
    monkeypatch.setattr(config, "FEEDBACK_FALLBACK", "none")
    monkeypatch.setattr(feedback, "generate", lambda backend, data: _gemma_down())
    with pytest.raises(feedback.ModelUnavailable):
        feedback.generate_with_fallback("gemma4-base", {})

    # A bad answer from a working Gemma is not "unavailable": no fallback.
    monkeypatch.setattr(config, "FEEDBACK_FALLBACK", "auto")

    def bad_answer(backend, data):
        raise feedback.FeedbackError("The feedback model returned output that does not match the schema.")

    monkeypatch.setattr(feedback, "generate", bad_answer)
    with pytest.raises(feedback.FeedbackError):
        feedback.generate_with_fallback("gemma4-base", {})


def test_claude_and_rules_never_fall_back():
    assert feedback.fallback_for("claude") is None
    assert feedback.fallback_for("rules") is None
    assert feedback.fallback_for("gemma4-ft") is not None


def test_ollama_asks_without_thinking_and_names_an_empty_answer(monkeypatch):
    monkeypatch.setattr(config, "OLLAMA_URL", "http://ollama.test")
    sent = {}

    def post(_url, json, **__):
        sent.update(json)
        return httpx.Response(200, json={"message": {"content": "", "thinking": "…"}, "done_reason": "stop"})

    monkeypatch.setattr(feedback.httpx, "post", post)
    with pytest.raises(feedback.ModelUnavailable, match="empty answer"):
        feedback._ollama("gemma4:e4b", {"transcript": [], "session": {}})
    assert sent["think"] is False


def test_ollama_errors_are_classified(monkeypatch):
    monkeypatch.setattr(config, "OLLAMA_URL", "http://ollama.test")

    def post(*_, **__):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(feedback.httpx, "post", post)
    with pytest.raises(feedback.ModelUnavailable):
        feedback._ollama("gemma4:e4b", {"transcript": [], "session": {}})

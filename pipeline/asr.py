"""Speech to text with word timestamps.

PITCH_ASR=duudlaga calls Duudlaga Developer API (POST /v1/stt/transcriptions).
Word timings are estimated from the returned text and billed duration — the
batch endpoint does not return per-word timestamps.

PITCH_ASR=whisper runs BuzzASR/mongolian (Whisper large-v3) through transformers.
The model returns text only; word timings are estimated from where the audio has sound.
PITCH_ASR=remote sends the WAV to the voice server (voice/server.py), which runs the
same Whisper model on another machine's GPU.
PITCH_ASR=stub returns sample sentences spread over the audio length, for testing
the API without a GPU. The report notes when the stub was used.
"""

import gc
import re
import wave
from pathlib import Path

import httpx
import numpy as np

from . import config, word_timing
from .audio import wav_duration
from .segments import Word

_model = None
_proc = None
_BATCH = 8  # pieces per generate call; fits an 8 GB card in fp16

# Map Duudlaga Developer API error codes to short UI messages.
_DUUDLAGA_MESSAGES = {
    "invalid_request": "The audio could not be sent for transcription.",
    "invalid_api_key": "Duudlaga API key is missing or invalid.",
    "insufficient_credits": "Duudlaga account has no STT credits left.",
    "payment_required": "Duudlaga account payment failed. Resolve billing to continue.",
    "no_speech": "No speech was detected in the audio.",
    "rate_limit_exceeded": "Duudlaga rate limit exceeded. Try again shortly.",
    "daily_spend_cap_exceeded": "Duudlaga daily spend cap reached for this API key.",
    "concurrency_limit_exceeded": "Too many Duudlaga transcriptions running at once.",
    "internal_error": "Duudlaga had an internal error. Try again.",
    "service_unavailable": "Duudlaga is temporarily unavailable.",
}


class AsrError(Exception):
    pass


class VoiceUnavailable(AsrError):
    """The voice server can't be used right now (down, unreachable, too slow, or the token was refused)."""


def transcribe_with_fallback(wav: Path) -> tuple[list[Word], str, str | None]:
    """Like transcribe(), but if the voice server can't be used, Duudlaga transcribes instead
    (PITCH_ASR_FALLBACK, with DUUDLAGA_API_KEY). Returns (words, backend, note); the note says why
    the fallback was used and is shown with the report."""
    try:
        words, used = transcribe(wav)
        return words, used, None
    except VoiceUnavailable as e:
        if config.ASR_FALLBACK != "duudlaga" or not config.DUUDLAGA_API_KEY:
            raise
        words = _duudlaga_words(wav)
        return words, "duudlaga", f"The voice server couldn't be used ({e}), so Duudlaga transcribed this recording."


def transcribe(wav: Path) -> tuple[list[Word], str]:
    """Returns (words, backend_name)."""
    if config.ASR_BACKEND == "stub":
        return _stub_words(wav_duration(wav)), "stub"
    if config.ASR_BACKEND == "duudlaga":
        return _duudlaga_words(wav), "duudlaga"
    if config.ASR_BACKEND == "remote":
        return _remote_words(wav), "remote"
    if config.ASR_BACKEND != "whisper":
        raise AsrError(f"Unknown PITCH_ASR value: {config.ASR_BACKEND}")
    return whisper_words(wav), "whisper"


def unload() -> None:
    """Free GPU memory before the feedback model runs (8 GB card)."""
    global _model, _proc
    if _model is None:
        return
    _model = _proc = None
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def is_loaded() -> bool:
    return _model is not None


def _load():
    """Load BuzzASR as its model card shows. The Mongolian/transcribe prompt is in its generation config."""
    global _model, _proc
    if _model is not None:
        return _model, _proc
    try:
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
    except ImportError as e:
        raise AsrError("Speech model is not installed. Install requirements-ml.txt or set PITCH_ASR=stub.") from e

    cuda = torch.cuda.is_available()
    model = WhisperForConditionalGeneration.from_pretrained(
        config.ASR_MODEL, dtype=torch.float16 if cuda else torch.float32
    )
    _model = model.to("cuda" if cuda else "cpu").eval()
    _proc = WhisperProcessor.from_pretrained(config.ASR_MODEL)
    return _model, _proc


def whisper_words(wav: Path) -> list[Word]:
    """Transcribe 16 kHz mono WAV in sentence-sized pieces; word times are estimated (see word_timing)."""
    import torch

    model, proc = _load()
    samples, sr = _read_wav(wav)
    duration = len(samples) / sr
    spans = word_timing.voiced_spans(samples, sr)

    pieces = []
    for lo, hi in word_timing.chunk_bounds(duration, spans):
        piece_spans = word_timing.clip_spans(spans, lo, hi)
        if sum(e - s for s, e in piece_spans) >= word_timing.MIN_SPEECH_S:  # skip silence: Whisper invents text there
            pieces.append((samples[int(lo * sr) : int(hi * sr)], piece_spans))

    words: list[Word] = []
    for i in range(0, len(pieces), _BATCH):
        batch = pieces[i : i + _BATCH]
        feats = proc([a for a, _ in batch], sampling_rate=sr, return_tensors="pt").input_features
        feats = feats.to(model.device, dtype=model.dtype)
        with torch.inference_mode():
            ids = model.generate(feats, num_beams=1, no_repeat_ngram_size=3, repetition_penalty=1.2)
        for text, (_, piece_spans) in zip(proc.batch_decode(ids, skip_special_tokens=True), batch):
            words.extend(word_timing.spread_words(text.split(), piece_spans))
    return words


def _read_wav(path: Path) -> tuple["np.ndarray", int]:
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise AsrError("Expected 16-bit mono WAV.")
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0, sr


def _remote_words(wav: Path) -> list[Word]:
    """Ask the voice server to transcribe. Retries once on connection errors and 502/503/504."""
    if not config.VOICE_TOKEN:
        raise AsrError("Set PITCH_VOICE_TOKEN (same value as VOICE_SERVER_TOKEN) for PITCH_ASR=remote.")

    url = f"{config.VOICE_URL}/v1/transcribe"
    headers = {"Authorization": f"Bearer {config.VOICE_TOKEN}"}
    timeout = httpx.Timeout(config.VOICE_TIMEOUT_S, connect=20.0)
    resp = None
    for attempt in range(2):
        try:
            with wav.open("rb") as f, httpx.Client(timeout=timeout) as client:
                resp = client.post(url, headers=headers, files={"file": (wav.name, f, "audio/wav")})
        except httpx.TimeoutException as e:
            raise VoiceUnavailable("The voice server took too long to transcribe. Try again.") from e
        except httpx.RequestError as e:
            if attempt == 0:
                continue
            raise VoiceUnavailable("Could not reach the voice server. Check that it and the tunnel are running.") from e
        if resp.status_code in (502, 503, 504) and attempt == 0:
            continue
        break

    if resp is None:
        raise VoiceUnavailable("Could not reach the voice server.")
    if resp.status_code in (502, 503, 504):
        raise VoiceUnavailable(f"The voice server isn't answering (HTTP {resp.status_code}).")
    if resp.status_code == 401:
        raise VoiceUnavailable("The voice server rejected PITCH_VOICE_TOKEN.")
    if resp.status_code >= 400:
        message = None
        try:
            message = resp.json().get("message")
        except ValueError:
            pass
        raise AsrError(message if isinstance(message, str) else f"Voice server failed (HTTP {resp.status_code}).")

    try:
        return parse_remote_words(resp.json())
    except ValueError as e:
        raise AsrError("The voice server returned an invalid response.") from e


def parse_remote_words(body: object) -> list[Word]:
    """Check the voice server's JSON: {"words": [{"word": str, "start": num, "end": num}, ...]}."""
    if not isinstance(body, dict) or not isinstance(body.get("words"), list):
        raise ValueError("missing words list")
    words: list[Word] = []
    for item in body["words"]:
        if not isinstance(item, dict):
            raise ValueError("word is not an object")
        text, start, end = item.get("word"), item.get("start"), item.get("end")
        if not isinstance(text, str) or isinstance(start, bool) or not isinstance(start, (int, float)):
            raise ValueError("bad word entry")
        if isinstance(end, bool) or not isinstance(end, (int, float)):
            end = start
        if not text.strip():
            continue
        words.append({"word": text.strip(), "start": float(start), "end": max(float(end), float(start))})
    return words


def _duudlaga_words(wav: Path) -> list[Word]:
    key = config.DUUDLAGA_API_KEY
    if not key:
        raise AsrError("Set DUUDLAGA_API_KEY (dk_live_…) for PITCH_ASR=duudlaga.")

    url = f"{config.DUUDLAGA_BASE_URL}/v1/stt/transcriptions"
    headers = {"Authorization": f"Bearer {key}"}
    mime = _audio_mime(wav)

    try:
        with wav.open("rb") as f:
            files = {"file": (wav.name, f, mime)}
            data = {"languages": config.DUUDLAGA_LANGUAGES}
            with httpx.Client(timeout=httpx.Timeout(300.0, connect=30.0)) as client:
                resp = client.post(url, headers=headers, files=files, data=data)
    except httpx.RequestError as e:
        raise AsrError(f"Could not reach Duudlaga: {e}") from e

    if resp.status_code == 422:
        # no_speech — same as empty recognition; caller raises "No speech was found".
        return []

    if resp.status_code >= 400:
        raise AsrError(_duudlaga_error_message(resp))

    try:
        body = resp.json()
    except ValueError as e:
        raise AsrError("Duudlaga returned an invalid response.") from e

    text = (body.get("text") or "").strip()
    if not text:
        return []

    try:
        samples, sr = _read_wav(wav)
        placed = word_timing.spread_words(text.split(), word_timing.voiced_spans(samples, sr))
    except (AsrError, OSError, wave.Error):
        placed = []
    if placed:
        return placed

    duration = body.get("duration_seconds")
    if not isinstance(duration, (int, float)) or duration <= 0:
        duration = wav_duration(wav)

    return _words_from_text(text, float(duration))


def _duudlaga_error_message(resp: httpx.Response) -> str:
    code = None
    try:
        payload = resp.json()
        code = payload.get("error")
    except ValueError:
        payload = None

    if isinstance(code, str) and code in _DUUDLAGA_MESSAGES:
        return _DUUDLAGA_MESSAGES[code]

    if resp.status_code == 401:
        return _DUUDLAGA_MESSAGES["invalid_api_key"]
    if resp.status_code == 402:
        return _DUUDLAGA_MESSAGES["insufficient_credits"]
    if resp.status_code == 429:
        retry = resp.headers.get("Retry-After")
        base = _DUUDLAGA_MESSAGES["rate_limit_exceeded"]
        return f"{base} Retry after {retry}s." if retry else base
    if resp.status_code >= 500:
        return _DUUDLAGA_MESSAGES["service_unavailable"]

    return f"Duudlaga transcription failed (HTTP {resp.status_code})."


def _audio_mime(path: Path) -> str:
    ext = path.suffix.lower()
    return {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
    }.get(ext, "application/octet-stream")


def _words_from_text(text: str, duration_s: float) -> list[Word]:
    """Spread recognised tokens evenly across the billed audio duration."""
    tokens = [t for t in re.split(r"\s+", text.strip()) if t]
    if not tokens:
        return []
    span = max(duration_s, 0.5)
    step = span / len(tokens)
    words: list[Word] = []
    t = 0.0
    for token in tokens:
        end = min(t + step * 0.9, span)
        words.append({"word": token, "start": round(t, 2), "end": round(end, 2)})
        t += step
    return words


_STUB_SENTENCES = [
    "Сайн байна уу, бид өнөөдөр шинэ төслөө танилцуулна.",
    "Ээ, оюутнууд илтгэл тавихаасаа өмнө дадлага хийх боломж бага байдаг.",
    "Манай судалгаагаар оюутнуудын гучин хувь нь илтгэл тавихаас айдаг.",
    "Бидний шийдэл бол хиймэл оюун ухаанд суурилсан илтгэлийн дасгалжуулагч юм.",
    "Та илтгэлээ бичүүлээд слайдаа оруулахад нэг минутын дотор зөвлөгөө авна.",
    "Нөгөө, бусад аппуудаас ялгаатай нь монгол хэлийг сайн ойлгодог.",
    "Бид эхний ээлжинд их сургуулийн оюутнуудад зориулж байна.",
    "Баярлалаа, асуулт байвал хариулахад бэлэн байна.",
]


def _stub_words(duration_s: float) -> list[Word]:
    tokens = [(w, i) for i, s in enumerate(_STUB_SENTENCES) for w in s.split()]
    span = max(duration_s, 5.0)
    step = span / (len(tokens) + len(_STUB_SENTENCES))
    words: list[Word] = []
    t = 0.0
    prev_sentence = 0
    for w, si in tokens:
        if si != prev_sentence:
            t += step  # small pause between sentences
            prev_sentence = si
        words.append({"word": w, "start": round(t, 2), "end": round(t + step * 0.8, 2)})
        t += step
    return words

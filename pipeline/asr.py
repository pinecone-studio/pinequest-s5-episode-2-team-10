"""Speech to text with word timestamps.

PITCH_ASR=duudlaga calls Duudlaga Developer API (POST /v1/stt/transcriptions).
Word timings are estimated from the returned text and billed duration — the
batch endpoint does not return per-word timestamps.

PITCH_ASR=whisper runs BuzzASR/mongolian (Whisper large-v3) through transformers.
PITCH_ASR=stub returns sample sentences spread over the audio length, for testing
the API without a GPU. The report notes when the stub was used.
"""

import gc
import re
from pathlib import Path

import httpx

from . import config
from .audio import wav_duration
from .segments import Word

_pipe = None

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


def transcribe(wav: Path) -> tuple[list[Word], str]:
    """Returns (words, backend_name)."""
    if config.ASR_BACKEND == "stub":
        return _stub_words(wav_duration(wav)), "stub"
    if config.ASR_BACKEND == "duudlaga":
        return _duudlaga_words(wav), "duudlaga"
    if config.ASR_BACKEND != "whisper":
        raise AsrError(f"Unknown PITCH_ASR value: {config.ASR_BACKEND}")
    return _whisper_words(wav), "whisper"


def unload() -> None:
    """Free GPU memory before the feedback model runs (8 GB card)."""
    global _pipe
    if _pipe is None:
        return
    _pipe = None
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def _load():
    global _pipe
    if _pipe is not None:
        return _pipe
    try:
        import torch
        from transformers import pipeline
    except ImportError as e:
        raise AsrError("Speech model is not installed. Install requirements-ml.txt or set PITCH_ASR=stub.") from e

    device = 0 if torch.cuda.is_available() else -1
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    _pipe = pipeline(
        "automatic-speech-recognition",
        model=config.ASR_MODEL,
        torch_dtype=dtype,
        device=device,
        chunk_length_s=30,
    )
    return _pipe


def _whisper_words(wav: Path) -> list[Word]:
    pipe = _load()
    out = pipe(
        str(wav),
        return_timestamps="word",
        generate_kwargs={"language": "mongolian", "task": "transcribe"},
    )
    words: list[Word] = []
    for chunk in out.get("chunks", []):
        start, end = chunk.get("timestamp", (None, None))
        text = chunk.get("text", "").strip()
        if not text or start is None:
            continue
        words.append({"word": text, "start": float(start), "end": float(end if end is not None else start)})
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

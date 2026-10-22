"""Speech to text with word timestamps.

PITCH_ASR=whisper runs BuzzASR/mongolian (Whisper large-v3) through transformers.
PITCH_ASR=stub returns sample sentences spread over the audio length, for testing
the API without a GPU. The report notes when the stub was used.
"""

import gc
from pathlib import Path

from . import config
from .audio import wav_duration
from .segments import Word

_pipe = None


class AsrError(Exception):
    pass


def transcribe(wav: Path) -> tuple[list[Word], str]:
    """Returns (words, backend_name)."""
    if config.ASR_BACKEND == "stub":
        return _stub_words(wav_duration(wav)), "stub"
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

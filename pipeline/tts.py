"""Mongolian text to speech for the coach voice, with Meta's MMS-TTS (facebook/mms-tts-mon).

A small VITS model (36M parameters, licence CC BY-NC 4.0). It runs on the CPU on purpose:
a sentence takes well under a second there, and it leaves the GPU's memory to BuzzASR and Gemma.
The model reads Cyrillic letters only, so digits are spelled out first; long text is spoken sentence by sentence.
"""

import io
import os
import re
import threading
import wave

MODEL_ID = os.environ.get("PITCH_TTS_MODEL", "facebook/mms-tts-mon").strip()
MAX_CHARS = 600
GAP_S = 0.25  # silence between sentences

_lock = threading.Lock()
_model = None
_tokenizer = None


class TtsError(Exception):
    pass


def _load():
    global _model, _tokenizer
    if _model is not None:
        return _model, _tokenizer
    try:
        import torch
        from transformers import AutoTokenizer, VitsModel
    except ImportError as e:  # pragma: no cover - depends on the machine
        raise TtsError("Text to speech needs torch and transformers on the voice server.") from e
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    _tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    _model = VitsModel.from_pretrained(MODEL_ID).eval()
    return _model, _tokenizer


# Mongolian numerals as (standalone, joined) forms: "гурав" alone, "гурван мянга" / "гурван хүн".
_UNITS = {1: ("нэг", "нэг"), 2: ("хоёр", "хоёр"), 3: ("гурав", "гурван"), 4: ("дөрөв", "дөрвөн"),
          5: ("тав", "таван"), 6: ("зургаа", "зургаан"), 7: ("долоо", "долоон"), 8: ("найм", "найман"),
          9: ("ес", "есөн")}
_TENS = {1: ("арав", "арван"), 2: ("хорь", "хорин"), 3: ("гуч", "гучин"), 4: ("дөч", "дөчин"),
         5: ("тавь", "тавин"), 6: ("жар", "жаран"), 7: ("дал", "далан"), 8: ("ная", "наян"), 9: ("ер", "ерэн")}
_HUNDRED, _THOUSAND, _MILLION = ("зуу", "зуун"), ("мянга", "мянган"), ("сая", "сая")


def _below_thousand(n: int) -> list[tuple[str, str]]:
    words: list[tuple[str, str]] = []
    if n >= 100:
        if n // 100 > 1:
            words.append(_UNITS[n // 100])
        words.append(_HUNDRED)
    if (n // 10) % 10:
        words.append(_TENS[(n // 10) % 10])
    if n % 10:
        words.append(_UNITS[n % 10])
    return words


def number_words(n: int, joined: bool = False) -> str:
    """An integer in Mongolian words; `joined` when a word follows it ("хорин дөрвөн онд")."""
    if n == 0:
        return "тэг"
    words: list[tuple[str, str]] = []
    for size, name in ((1_000_000, _MILLION), (1_000, _THOUSAND)):
        if n >= size:
            if n // size > 1 or size == 1_000_000:
                words += _below_thousand(n // size)
            words.append(name)
            n %= size
    words += _below_thousand(n)
    # Parts before the last take their joined form ("хорин", "зуун"), except "мянга", which stays
    # as is before more numbers ("хоёр мянга хорин"); the last part depends on what follows.
    inner = [w[0] if w == _THOUSAND else w[1] for w in words[:-1]]
    return " ".join(inner + [words[-1][1] if joined else words[-1][0]])


_NUMBER = re.compile(r"(\d+)(?:[.,](\d+))?(\s*%)?")
_WORD_NEXT = re.compile(r"\s*[^\W\d_]")


def spell_numbers(text: str) -> str:
    """Digits as Mongolian words, since the voice model only reads letters."""

    def replace(m: re.Match) -> str:
        whole, frac, percent = m.group(1), m.group(2), m.group(3)
        word_after = _WORD_NEXT.match(m.string, m.end())
        if len(whole) > 9:
            return " ".join(number_words(int(d)) for d in whole)
        if frac:
            spoken = f"{number_words(int(whole))} цэг {number_words(int(frac))}"
            return spoken + (" хувь" if percent else "")
        if percent:
            return f"{number_words(int(whole), joined=True)} хувь"
        return number_words(int(whole), joined=bool(word_after))

    return _NUMBER.sub(replace, text)


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?…])\s+|\n+", text.strip())
    return [p.strip() for p in parts if re.search(r"\w", p)]


def synthesize(text: str) -> bytes:
    """WAV bytes (16-bit mono) of `text` read aloud."""
    text = text.strip()
    if not text:
        raise TtsError("No text to speak.")
    if len(text) > MAX_CHARS:
        raise TtsError("Text is too long to speak.")

    import numpy as np
    import torch

    with _lock:
        model, tokenizer = _load()
        rate = model.config.sampling_rate
        gap = np.zeros(int(rate * GAP_S), dtype=np.float32)
        pieces = []
        for sentence in _sentences(spell_numbers(text)):
            inputs = tokenizer(sentence, return_tensors="pt")
            if inputs["input_ids"].shape[1] < 2:
                continue  # nothing the model can read (only digits or symbols)
            with torch.no_grad():
                pieces += [model(**inputs).waveform[0].numpy(), gap]
    if not pieces:
        raise TtsError("Nothing in the text could be read aloud.")

    audio = np.concatenate(pieces[:-1])
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return out.getvalue()

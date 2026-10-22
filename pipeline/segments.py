"""Split word timestamps into sentences with start and end times."""

from typing import TypedDict


class Word(TypedDict):
    word: str
    start: float
    end: float


class Sentence(TypedDict):
    text: str
    start: float
    end: float


SENTENCE_END = (".", "?", "!", "…")
PAUSE_BREAK_S = 0.7  # TDD: split at punctuation or pauses over 0.7 s
MAX_WORDS = 40  # keep very long run-ons from becoming one segment


def to_sentences(words: list[Word]) -> list[Sentence]:
    sentences: list[Sentence] = []
    current: list[Word] = []

    def flush() -> None:
        if current:
            text = " ".join(w["word"].strip() for w in current).strip()
            sentences.append({"text": text, "start": current[0]["start"], "end": current[-1]["end"]})
            current.clear()

    for i, w in enumerate(words):
        if current and w["start"] - current[-1]["end"] > PAUSE_BREAK_S:
            flush()
        current.append(w)
        is_last = i == len(words) - 1
        if w["word"].strip().endswith(SENTENCE_END) or len(current) >= MAX_WORDS or is_last:
            flush()

    return sentences

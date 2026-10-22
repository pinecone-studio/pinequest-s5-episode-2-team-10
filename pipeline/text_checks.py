"""Wording checks: fillers, repeated words, sentence length."""

import re
from functools import lru_cache
from pathlib import Path

from .segments import Sentence

FILLERS_FILE = Path(__file__).with_name("fillers_mn.txt")
LONG_SENTENCE_WORDS = 25
WORD_RE = re.compile(r"\w+")


@lru_cache
def load_fillers() -> tuple[str, ...]:
    lines = FILLERS_FILE.read_text(encoding="utf-8").splitlines()
    items = [ln.strip().lower() for ln in lines if ln.strip() and not ln.startswith("#")]
    # Longest first so "тэгээд тэгээд" is counted before shorter matches.
    return tuple(sorted(set(items), key=len, reverse=True))


def tokens(text: str) -> list[str]:
    return WORD_RE.findall(text.lower())


def check(sentences: list[Sentence]) -> dict:
    text = " ".join(s["text"] for s in sentences)
    words = tokens(text)
    n_words = len(words)

    filler_counts: dict[str, int] = {}
    joined = " " + " ".join(words) + " "
    for f in load_fillers():
        pattern = " " + f + " "
        count = joined.count(pattern)
        if count:
            filler_counts[f] = count
            joined = joined.replace(pattern, " ")
    filler_total = sum(filler_counts.values())

    repeats = [words[i] for i in range(1, n_words) if words[i] == words[i - 1] and len(words[i]) > 1]

    lengths = [len(tokens(s["text"])) for s in sentences]
    long_sentences = [
        {"text": s["text"], "start": s["start"], "words": n}
        for s, n in zip(sentences, lengths)
        if n > LONG_SENTENCE_WORDS
    ]

    return {
        "word_count": n_words,
        "fillers": filler_counts,
        "filler_total": filler_total,
        "fillers_per_100": round(filler_total / n_words * 100, 2) if n_words else None,
        "repeats": len(repeats),
        "avg_sentence_words": round(sum(lengths) / len(lengths), 1) if lengths else None,
        "long_sentences": long_sentences[:5],
    }

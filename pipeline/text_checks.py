"""Wording checks: fillers, repeated words, sentence length."""

from collections import Counter

from .fillers import find_candidates
from .segments import Sentence
from .tokens import tokens

__all__ = ["check", "tokens"]

LONG_SENTENCE_WORDS = 25


def check(sentences: list[Sentence]) -> dict:
    """List-based counts. The feedback step later replaces the filler numbers with
    occurrences confirmed in context (see fillers.py)."""
    text = " ".join(s["text"] for s in sentences)
    words = tokens(text)
    n_words = len(words)

    candidates = find_candidates(sentences)
    filler_counts = dict(Counter(c["word"] for c in candidates))
    filler_total = len(candidates)

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

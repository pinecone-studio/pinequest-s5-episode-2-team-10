"""Filler words: list candidates, verify what the model reports, and summarize.

1. `find_candidates` marks every occurrence of a word from fillers_mn.txt, per sentence.
2. The feedback model decides in context which occurrences really are fillers ("тэгээд" can
   be a filler or "and then") and may add fillers the list misses.
3. `verify` keeps only occurrences that exist in the named sentence, so the model can't
   invent or over-count them.
4. `summarize` counts in code and keeps sentence evidence and timestamps.
"""

from collections import defaultdict
from functools import lru_cache
from pathlib import Path

from .tokens import tokens

FILLERS_FILE = Path(__file__).with_name("fillers_mn.txt")
MAX_FILLER_TOKENS = 4  # a filler is a short sound or phrase, not a clause
MAX_EVIDENCE = 3

NO_FILLERS_NOTE = (
    "No filler words were found. Speech recognition can drop hesitation sounds "
    "like “ээ” or “аан”, so the real number may be higher."
)


@lru_cache
def load_list() -> tuple[tuple[str, ...], ...]:
    """Filler phrases as token tuples, longest first so phrases win over their parts."""
    lines = FILLERS_FILE.read_text(encoding="utf-8").splitlines()
    phrases = {tuple(tokens(ln)) for ln in lines if ln.strip() and not ln.lstrip().startswith("#")}
    return tuple(sorted((p for p in phrases if p), key=len, reverse=True))


def count_in(text: str, phrase: str) -> int:
    """How many times `phrase` occurs in `text` as whole words."""
    words, p = tokens(text), tokens(phrase)
    if not p:
        return 0
    n = len(p)
    return sum(1 for i in range(len(words) - n + 1) if words[i : i + n] == p)


def find_candidates(sentences: list[dict]) -> list[dict]:
    """Every occurrence of a listed filler: [{sentence_id, word}]."""
    phrases = load_list()
    out = []
    for sid, s in enumerate(sentences):
        words = tokens(s["text"])
        i = 0
        while i < len(words):
            for p in phrases:
                if tuple(words[i : i + len(p)]) == p:
                    out.append({"sentence_id": sid, "word": " ".join(p)})
                    i += len(p)
                    break
            else:
                i += 1
    return out


def verify(occurrences: list[dict], sentences: list[dict]) -> list[dict]:
    """Keep occurrences whose word is really in that sentence, at most as often as it appears."""
    listed: dict[tuple[int, str], int] = defaultdict(int)
    order: list[tuple[int, str]] = []
    for o in occurrences:
        sid = o.get("sentence_id")
        word = " ".join(tokens(str(o.get("word", ""))))
        if not isinstance(sid, int) or not 0 <= sid < len(sentences):
            continue
        if not word or len(word.split()) > MAX_FILLER_TOKENS:
            continue
        key = (sid, word)
        if key not in listed:
            order.append(key)
        listed[key] += 1

    out = []
    for sid, word in order:
        n = min(listed[(sid, word)], count_in(sentences[sid]["text"], word))
        out += [{"sentence_id": sid, "word": word}] * n
    return out


def summarize(occurrences: list[dict], sentences: list[dict], word_count: int, method: str) -> dict:
    """Counts per filler with evidence sentences and timestamps. Totals come from code."""
    by_word: dict[str, list[int]] = defaultdict(list)
    for o in occurrences:
        by_word[o["word"]].append(o["sentence_id"])

    words = []
    for word, ids in by_word.items():
        unique_ids = list(dict.fromkeys(ids))
        words.append({
            "word": word,
            "count": len(ids),
            "evidence": [sentences[i]["text"] for i in unique_ids[:MAX_EVIDENCE]],
            "occurrences": [{"sentence_id": i, "start_s": sentences[i]["start"]} for i in ids],
        })
    words.sort(key=lambda w: (-w["count"], w["word"]))

    total = len(occurrences)
    return {
        "method": method,  # "llm": confirmed by the feedback model; "model": the filler classifier; "list": word list only
        "total": total,
        "per_100": round(total / word_count * 100, 2) if word_count else None,
        "words": words,
        "note": NO_FILLERS_NOTE if total == 0 and word_count else None,
    }

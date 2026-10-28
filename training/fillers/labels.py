"""Hand-labelled filler words: one row per transcript sentence, fillers marked by token position.

Row format (labels.jsonl):
    {"pitch": "team-a", "sentence_id": 0, "text": "Ээ, бид ...", "tokens": ["ээ", "бид", ...],
     "filler_idx": [0], "checked": false}

Positions, not words, so "тэгээд" can be a filler in one place and "and then" in the next.
"""

import json
from collections import defaultdict
from pathlib import Path

from pipeline.tokens import tokens


def positions(words: list[str], occurrences: list[str]) -> set[int]:
    """Token positions of each occurrence (a word or phrase), left to right, without reusing a token.

    Model and list output name fillers by word per sentence; this places them in the sentence so
    they can be compared with hand labels. A word that isn't in the sentence is ignored.
    """
    used: set[int] = set()
    for occ in occurrences:
        p = tokens(occ)
        n = len(p)
        if not n:
            continue
        for i in range(len(words) - n + 1):
            span = range(i, i + n)
            if words[i : i + n] == p and not used.intersection(span):
                used.update(span)
                break
    return used


def read(path: Path) -> list[dict]:
    return [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def write(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def by_pitch(rows: list[dict]) -> dict[str, list[dict]]:
    """Rows grouped per pitch, in sentence order."""
    out: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        out[row["pitch"]].append(row)
    for pitch_rows in out.values():
        pitch_rows.sort(key=lambda r: r["sentence_id"])
    return dict(out)


def score(rows: list[dict], predicted: dict[tuple[str, int], set[int]]) -> dict:
    """Token-level precision, recall and F1 of `predicted` against the hand labels in `rows`.

    `predicted` maps (pitch, sentence_id) to filler token positions. Per-word counts show which
    words are missed (fn) or wrongly flagged (fp).
    """
    tp = fp = fn = 0
    per_word: dict[str, dict[str, int]] = defaultdict(lambda: {"tp": 0, "fp": 0, "fn": 0})
    for row in rows:
        gold = set(row["filler_idx"])
        pred = predicted.get((row["pitch"], row["sentence_id"]), set())
        for kind, idx in (("tp", gold & pred), ("fp", pred - gold), ("fn", gold - pred)):
            for i in idx:
                per_word[row["tokens"][i]][kind] += 1
        tp += len(gold & pred)
        fp += len(pred - gold)
        fn += len(gold - pred)

    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else (0.0 if tp + fp + fn else None)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": precision, "recall": recall, "f1": f1,
            "per_word": dict(per_word)}

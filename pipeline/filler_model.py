"""Filler words from the fine-tuned token classifier (training/fillers/classifier.py).

PITCH_FILLER_MODEL picks where it runs:
- "" (default): off. Fillers come from the word list and the feedback model, as before.
- a model folder: run it in this process (needs torch + transformers and ~1.5 GB of RAM).
- "remote": ask the voice server's /v1/fillers, for hosts without the RAM (Render).

When it is on, its marks replace the feedback model's filler list; any failure falls back to that list,
so an analysis never stops on it. Results still go through fillers.verify().
"""

import logging
from functools import lru_cache

import httpx

from . import config, fillers
from .tokens import tokens

MAX_LEN = 128  # tokens per sentence; sentences are split at 40 words
BATCH = 32
TIMEOUT_S = 60

log = logging.getLogger(__name__)


class FillerModelError(Exception):
    pass


def to_occurrences(sentences: list[dict], marked: list[list[int]]) -> list[dict]:
    """Marked token positions per sentence → [{sentence_id, word}].

    Within a run of marked tokens, a listed phrase ("юу гэдэг юм") stays one occurrence; other tokens
    count one each ("ээ ээ" is two).
    """
    phrases = fillers.load_list()  # longest first
    out = []
    for sid, (s, idx) in enumerate(zip(sentences, marked)):
        words = tokens(s["text"])
        keep = {i for i in idx if 0 <= i < len(words)}
        i = 0
        while i < len(words):
            if i not in keep:
                i += 1
                continue
            for p in phrases:
                n = len(p)
                if n > 1 and tuple(words[i : i + n]) == p and all(j in keep for j in range(i, i + n)):
                    out.append({"sentence_id": sid, "word": " ".join(p)})
                    i += n
                    break
            else:
                out.append({"sentence_id": sid, "word": words[i]})
                i += 1
    return out


@lru_cache(maxsize=1)
def _load(path: str):
    import torch
    from transformers import AutoModelForTokenClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(path)
    model = AutoModelForTokenClassification.from_pretrained(path).eval()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    return tokenizer, model.to(device), device


def mark(texts: list[str], path: str) -> list[list[int]]:
    """Filler token positions for each sentence, with the model at `path`."""
    import torch

    tokenizer, model, device = _load(path)
    words = [tokens(t) for t in texts]
    out: list[list[int]] = [[] for _ in texts]
    todo = [i for i, w in enumerate(words) if w]
    for b in range(0, len(todo), BATCH):
        part = todo[b : b + BATCH]
        enc = tokenizer([words[i] for i in part], is_split_into_words=True, truncation=True,
                        max_length=MAX_LEN, padding=True, return_tensors="pt")
        with torch.no_grad():
            pred = model(**{k: v.to(device) for k, v in enc.items()}).logits.argmax(-1).tolist()
        for row, i in enumerate(part):
            seen = set()
            for pos, w in enumerate(enc.word_ids(row)):
                if w is not None and w not in seen:  # a word's label sits on its first piece
                    seen.add(w)
                    if pred[row][pos] == 1:
                        out[i].append(w)
    return out


def parse_marks(body: object, n: int) -> list[list[int]]:
    """Check the voice server's JSON: {"marked": [[int, ...], ...]}, one list per sentence."""
    marked = body.get("marked") if isinstance(body, dict) else None
    if not isinstance(marked, list) or len(marked) != n:
        raise FillerModelError("expected one list of positions per sentence")
    out = []
    for m in marked:
        if not isinstance(m, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in m):
            raise FillerModelError("positions must be integers")
        out.append(m)
    return out


class FillerModelError(FillerModelError, ValueError):
    pass


def _remote(texts: list[str]) -> list[list[int]]:
    headers = {"Authorization": f"Bearer {config.VOICE_TOKEN}"} if config.VOICE_TOKEN else None
    resp = httpx.post(f"{config.VOICE_URL}/v1/fillers", json={"sentences": texts}, headers=headers, timeout=TIMEOUT_S)
    if resp.status_code >= 400:
        raise FillerModelError(f"voice server returned HTTP {resp.status_code}")
    return parse_marks(resp.json(), len(texts))


def find(sentences: list[dict]) -> list[dict] | None:
    """Filler occurrences from the classifier, or None when it is off or unavailable."""
    setting = config.FILLER_MODEL
    if not setting or not sentences:
        return None
    texts = [s["text"] for s in sentences]
    try:
        marked = _remote(texts) if setting == "remote" else mark(texts, setting)
    except Exception as e:  # the word list and the feedback model still cover fillers
        log.warning("Filler model unavailable (%s); using the feedback model's fillers.", type(e).__name__)
        return None
    return to_occurrences(sentences, marked)

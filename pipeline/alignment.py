"""Match speech to slides from content alone (we have no slide timing).

1. Similarity between every sentence and every text slide (e5 embeddings, or key-term overlap).
2. Dynamic programming assigns each sentence to a slide; the slide number can only stay or go up.
3. A slide is covered when its best sentence is similar enough AND half its key terms were said.
4. Numbers on a slide that do not appear near its time range become mismatch candidates;
   the feedback model decides which are real.
"""

import re

import numpy as np

from . import config
from .segments import Sentence
from .slides import SlideText
from .tokens import tokens

PREFIX = 5  # match words on the first 5 letters to survive Mongolian suffixes
NUMBER_WINDOW_S = 10.0

# Thresholds per similarity method. Tune on our own decks.
THRESHOLDS = {
    "e5": {"covered": 0.82, "skip_penalty": 0.02},
    "overlap": {"covered": 0.25, "skip_penalty": 0.05},
}

_model = None


def align(sentences: list[Sentence], slides: list[SlideText]) -> dict:
    text_slides = [s for s in slides if not s["image_only"]]
    if not text_slides or not sentences:
        return {"method": None, "coverage": None, "slides": [_empty(s) for s in slides], "number_candidates": []}

    sim, method = _similarity(sentences, text_slides)
    th = THRESHOLDS[method]
    assigned = _assign(sim, th["skip_penalty"])

    said_prefixes = {w[:PREFIX] for s in sentences for w in tokens(s["text"])}
    by_number: dict[int, dict] = {}
    candidates = []

    for j, slide in enumerate(text_slides):
        idx = [i for i, a in enumerate(assigned) if a == j]
        best = float(sim[:, j].max())
        terms = slide["key_terms"]
        found = [t for t in terms if t[:PREFIX] in said_prefixes]
        terms_ok = not terms or len(found) >= len(terms) / 2
        sim_ok = best >= th["covered"]
        status = "covered" if sim_ok and terms_ok else "partial" if sim_ok or terms_ok else "missed"

        start = sentences[idx[0]]["start"] if idx else None
        end = sentences[idx[-1]]["end"] if idx else None
        by_number[slide["number"]] = {
            "slide": slide["number"],
            "status": status,
            "start_s": start,
            "end_s": end,
            "best_similarity": round(best, 3),
            "key_terms_found": found,
            "key_terms_missing": [t for t in terms if t not in found],
            "sentence_ids": idx,
        }
        candidates += _number_candidates(slide, sentences, start, end)

    results = [by_number.get(s["number"]) or _empty(s) for s in slides]
    covered = sum(1 for r in results if r["status"] == "covered")
    return {
        "method": method,
        "coverage": round(covered / len(text_slides), 3),
        "slides": results,
        "number_candidates": candidates,
    }


def _empty(slide: SlideText) -> dict:
    return {
        "slide": slide["number"],
        "status": "image_only" if slide["image_only"] else "missed",
        "start_s": None,
        "end_s": None,
        "best_similarity": None,
        "key_terms_found": [],
        "key_terms_missing": slide["key_terms"],
        "sentence_ids": [],
    }


def _similarity(sentences: list[Sentence], slides: list[SlideText]) -> tuple[np.ndarray, str]:
    if config.EMBEDDINGS == "e5":
        model = _load_e5()
        if model is not None:
            s_emb = model.encode([f"query: {s['text']}" for s in sentences], normalize_embeddings=True)
            d_emb = model.encode([f"passage: {s['text'][:600]}" for s in slides], normalize_embeddings=True)
            return np.asarray(s_emb) @ np.asarray(d_emb).T, "e5"

    # Key-term overlap: share of a slide's key terms found in each sentence.
    sim = np.zeros((len(sentences), len(slides)))
    for i, s in enumerate(sentences):
        said = {w[:PREFIX] for w in tokens(s["text"])}
        for j, slide in enumerate(slides):
            terms = slide["key_terms"]
            if terms:
                sim[i, j] = sum(t[:PREFIX] in said for t in terms) / len(terms)
    return sim, "overlap"


def _load_e5():
    global _model
    if _model is None:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError:
            return None  # falls back to key-term overlap; report says which method ran
        _model = SentenceTransformer(config.EMBEDDING_MODEL, device="cpu")
    return _model


def _assign(sim: np.ndarray, skip_penalty: float) -> list[int]:
    """Monotonic assignment: best total similarity where slide index never goes down."""
    n, m = sim.shape
    score = np.full((n, m), -np.inf)
    back = np.zeros((n, m), dtype=int)
    score[0] = sim[0] - skip_penalty * np.arange(m)  # starting late skips early slides
    for i in range(1, n):
        for j in range(m):
            prev = score[i - 1, : j + 1] - skip_penalty * np.maximum(0, j - np.arange(j + 1) - 1)
            k = int(np.argmax(prev))
            score[i, j] = sim[i, j] + prev[k]
            back[i, j] = k
    path = [int(np.argmax(score[-1]))]
    for i in range(n - 1, 0, -1):
        path.append(int(back[i, path[-1]]))
    return path[::-1]


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value)


def _number_candidates(slide: SlideText, sentences: list[Sentence], start, end) -> list[dict]:
    if start is None:
        nearby = sentences
    else:
        nearby = [s for s in sentences if s["end"] >= start - NUMBER_WINDOW_S and s["start"] <= end + NUMBER_WINDOW_S]
    nearby_text = " ".join(s["text"] for s in nearby)
    searchable = nearby_text.replace(",", "").replace(".", "")

    out = []
    for value in slide["numbers"]:
        d = _digits(value)
        if d and re.search(rf"(?<!\d){d}(?!\d)", searchable):
            continue  # said as digits nearby; numbers said as words go to the model
        out.append({"slide": slide["number"], "on_slide": value, "nearby_text": nearby_text[:400]})
    return out

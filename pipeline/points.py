"""Main points: did the speech cover the speaker's own pitch idea and key messages?

The speaker lists up to MAX_POINTS main points. The feedback model marks each one covered,
partial or missed and quotes the transcript as evidence. Code then:
- keeps one result per point (a point the model skipped counts as missed),
- checks that every quote is really in the transcript; a covered/partial point whose quote
  isn't there is marked unverified and scored as missed,
- keeps off-topic flags only for sentences that exist, and quotes them itself,
- computes coverage: covered = 1, partial = 0.5, missed = 0, averaged over the points.

Without a model (`rules`), points are matched to sentences by key words (first 5 letters,
so Mongolian suffixes still match). That is a rough estimate and the report says so.
"""

from .tokens import tokens

MAX_POINTS = 6
MAX_POINT_CHARS = 200
STATUSES = ("covered", "partial", "missed")
STATUS_VALUE = {"covered": 1.0, "partial": 0.5, "missed": 0.0}

PREFIX = 5
RULES_COVERED = 0.6  # share of a point's key words said in one place
RULES_PARTIAL = 0.3

# Common words that say nothing about a point's topic.
STOPWORDS = {
    "бол", "нь", "юм", "энэ", "тэр", "эдгээр", "тэдгээр", "бид", "би", "та", "манай", "бидний", "миний",
    "ба", "болон", "мөн", "гэж", "гэх", "гэсэн", "байна", "байгаа", "байдаг", "байсан", "байх", "бөгөөд",
    "их", "маш", "нэг", "ямар", "юу", "яаж", "хэрхэн", "учир", "тул", "дээр", "доор", "руу", "рүү",
    "the", "and", "for", "with", "that", "this", "our", "are", "is",
}


def clean_points(points: object) -> list[str]:
    """Trimmed, non-empty points, at most MAX_POINTS of at most MAX_POINT_CHARS each."""
    if not isinstance(points, list):
        return []
    out = [" ".join(str(p).split())[:MAX_POINT_CHARS] for p in points if isinstance(p, str)]
    return [p for p in out if p][:MAX_POINTS]


def _terms(text: str) -> set[str]:
    return {t[:PREFIX] for t in tokens(text) if len(t) >= 3 and t not in STOPWORDS}


def _norm(text: str) -> str:
    return " ".join(tokens(text))


def rules_check(points: list[str], sentences: list[dict]) -> list[dict]:
    """Best place each point's key words were said (one sentence or two in a row)."""
    # Single sentences first, so on a tie the shorter quote wins.
    windows: list[tuple[str, set[str]]] = [(s["text"], _terms(s["text"])) for s in sentences]
    for a, b in zip(sentences, sentences[1:]):
        pair = f"{a['text']} {b['text']}"
        windows.append((pair, _terms(pair)))

    checks = []
    for i, point in enumerate(points):
        terms = _terms(point)
        best_share, best_text = 0.0, ""
        if terms:
            for text, said in windows:
                share = len(terms & said) / len(terms)
                if share > best_share:
                    best_share, best_text = share, text
        status = "covered" if best_share >= RULES_COVERED else "partial" if best_share >= RULES_PARTIAL else "missed"
        checks.append({
            "point": i,
            "status": status,
            "evidence": best_text if status != "missed" else "",
            "note": "",
        })
    return checks


def verify(checks: list[dict], points: list[str], sentences: list[dict], off_topic: list[dict],
           idea_comment: str, method: str, idea: str = "") -> dict:
    """Model (or rules) output -> results the report can trust. See the module docstring."""
    transcript = f" {_norm(' '.join(s['text'] for s in sentences))} "
    by_point: dict[int, dict] = {}
    for c in checks:
        idx = c.get("point")
        if isinstance(idx, int) and 0 <= idx < len(points) and idx not in by_point:
            by_point[idx] = c

    results = []
    total = 0.0
    for i, text in enumerate(points):
        c = by_point.get(i, {})
        status = c.get("status") if c.get("status") in STATUSES else "missed"
        evidence = " ".join(str(c.get("evidence") or "").split())
        quoted = _norm(evidence)
        verified = status == "missed" or bool(quoted and f" {quoted} " in transcript)
        total += STATUS_VALUE[status] if verified else 0.0
        results.append({
            "point": i,
            "text": text,
            "status": status,
            "verified": verified,
            "evidence": evidence if verified and status != "missed" else "",
            "note": " ".join(str(c.get("note") or "").split()),
        })

    # Small models flag too much as off topic. A sentence that shares a key word with the idea or
    # a main point is at least related, so its flag is dropped (conservative: may keep a real one out).
    related = _terms(idea).union(*(_terms(p) for p in points)) if (idea or points) else set()
    flagged = []
    seen: set[int] = set()
    for item in off_topic:
        sid = item.get("sentence_id")
        if (isinstance(sid, int) and 0 <= sid < len(sentences) and sid not in seen
                and not (_terms(sentences[sid]["text"]) & related)):
            seen.add(sid)
            reason = " ".join(str(item.get("reason") or "").split())
            if _norm(reason) == _norm(sentences[sid]["text"]):
                reason = ""  # a "reason" that only repeats the sentence says nothing
            flagged.append({
                "sentence_id": sid,
                "start": sentences[sid].get("start"),
                "text": sentences[sid]["text"],  # quoted by code, not by the model
                "reason": reason,
            })

    return {
        "method": method,
        "points": results,
        "coverage": round(100 * total / len(points)) if points else None,
        "off_topic": sorted(flagged, key=lambda f: f["sentence_id"]),
        "idea_comment": " ".join((idea_comment or "").split()),
    }

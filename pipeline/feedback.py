"""Feedback step: judges content against the rubric and writes recommendations.

Backends (the app's setting):
  claude       Claude through the Anthropic API (sends the analysis to Anthropic)
  gemma4-ft    our fine-tuned Gemma 4 E4B in Ollama
  gemma4-base  base Gemma 4 E4B in Ollama, same prompt (for comparison)
  rules        no model; measurement-based advice only (offline testing)

All model backends get the same prompt and JSON schema, so the eval compares like with like.
The output is checked afterwards: timestamps and slide numbers that are not in the input are
set to null, and scores are clamped to 0..100.
"""

import json
import re
import os
from pathlib import Path
from typing import Literal, Optional

import httpx
from pydantic import BaseModel, ConfigDict, Field

from . import config, filler_model, fillers, points

Backend = Literal["claude", "gemma4-ft", "gemma4-base", "rules"]
BACKENDS: tuple[str, ...] = ("claude", "gemma4-ft", "gemma4-base", "rules")

PROMPT = (Path(__file__).parent / "prompts" / "feedback_v2.md").read_text(encoding="utf-8")
PROMPT_VERSION = "v2.4-short-previous-takes"  # stored with each report; bump when the prompt or schema changes
MAX_RECOMMENDATIONS = 5
SLIDE_WORDS = 60  # trim slide text so a 3-minute pitch plus 10 slides fits in 6144 tokens
SCRIPT_WORDS = 600  # about 4 minutes of speech

CRITERIA = {
    "startup": ["problem", "solution", "target_user", "value", "logical_order", "conclusion_cta"],
    "academic": ["research_question", "method", "results", "contribution", "logical_order", "conclusion"],
}


class FeedbackError(Exception):
    pass


class ModelUnavailable(FeedbackError):
    """The feedback model can't be used right now (Ollama down, unreachable, or missing the model)."""


# ---- Schema v2 -------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ContentScore(_Strict):
    criterion: str
    score: int
    evidence: str
    recommendation: str


class SlideFeedback(_Strict):
    slide: int
    status: Literal["covered", "partial", "missed", "image_only"]
    comment: str


class NumberCheck(_Strict):
    slide: int
    on_slide: str
    said: Optional[str]
    inconsistent: bool


class Recommendation(_Strict):
    area: Literal["structure", "content", "delivery", "slides", "accuracy", "timing"]
    problem: str
    start_s: Optional[float]
    slide: Optional[int]
    why: str
    action: str
    example_sentence: str
    impact: Literal["high", "medium", "low"]


class PracticeTask(_Strict):
    title: str = Field(min_length=2, max_length=60)
    instruction: str = Field(min_length=4, max_length=300)
    goal: str = Field(min_length=4, max_length=160)


class FillerOccurrence(_Strict):
    sentence_id: int
    word: str


class PointCheck(_Strict):
    point: int
    status: Literal["covered", "partial", "missed"]
    evidence: str
    note: str


class OffTopic(_Strict):
    sentence_id: int
    reason: str


class Feedback(_Strict):
    summary: str
    strengths: list[str]
    content_scores: list[ContentScore]
    slide_feedback: list[SlideFeedback]
    number_checks: list[NumberCheck]
    recommendations: list[Recommendation]
    practice_tasks: list[PracticeTask] = Field(min_length=2, max_length=3)
    filler_occurrences: list[FillerOccurrence]
    point_checks: list[PointCheck]
    off_topic: list[OffTopic]
    idea_comment: str


def _inline_refs(schema: dict) -> dict:
    """Replace $ref links with their definitions; some JSON-schema consumers skip $defs."""
    defs = schema.pop("$defs", {})

    def walk(node):
        if isinstance(node, dict):
            if "$ref" in node:
                return walk(defs[node["$ref"].split("/")[-1]])
            return {k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(schema)


SCHEMA = _inline_refs(Feedback.model_json_schema())


# ---- Entry point -----------------------------------------------------------


def build_input(session: dict, sentences: list[dict], metrics: dict, wording: dict, slides: list[dict], alignment: dict) -> dict:
    info = {k: v for k, v in session.items() if k not in ("script", "idea", "key_points", "previous_takes")}
    script = " ".join((session.get("script") or "").split()[:SCRIPT_WORDS])
    key_points = points.clean_points(session.get("key_points"))
    return {
        "session": info,
        # Earlier analysed takes of this pitch (newest first): their fixes, main points, pace and fillers.
        # Near the top, so the model weighs them when it writes the summary.
        "previous_takes": session.get("previous_takes") or [],
        "script": script or None,
        # The speaker's own pitch idea and main points; the model checks each against the transcript.
        "pitch": {
            "idea": " ".join((session.get("idea") or "").split())[:500] or None,
            "key_points": [{"id": i, "text": p} for i, p in enumerate(key_points)],
        },
        "criteria": CRITERIA.get(session.get("pitch_type", "startup"), CRITERIA["startup"]),
        "transcript": [{"id": i, **s} for i, s in enumerate(sentences)],
        "metrics": metrics,
        "wording": wording,
        "slides": [
            {"number": s["number"], "text": " ".join(s["text"].split()[:SLIDE_WORDS]), "image_only": s["image_only"]}
            for s in slides
        ],
        "alignment": [
            {k: a[k] for k in ("slide", "status", "start_s", "end_s", "key_terms_missing")}
            for a in alignment.get("slides", [])
        ],
        "number_candidates": alignment.get("number_candidates", []),
        # Every listed filler word found by code; the model confirms each one in context.
        "filler_candidates": fillers.find_candidates(sentences),
    }


def fallback_for(backend: str) -> str | None:
    """The model to use when `backend` (a Gemma model) can't be reached, or None."""
    if not backend.startswith("gemma4") and not backend.startswith("ollama:"):
        return None
    choice = config.FEEDBACK_FALLBACK
    if choice == "auto":
        return "claude" if os.environ.get("ANTHROPIC_API_KEY", "").strip() else "rules"  # the SDK reads this key
    return choice if choice in ("claude", "rules") else None


def generate_with_fallback(backend: str, data: dict) -> tuple[dict, str, str | None]:
    """Like generate(), but if Gemma can't be reached, another model writes the feedback
    (PITCH_FEEDBACK_FALLBACK). Returns (feedback, backend used, note shown with the report)."""
    try:
        return generate(backend, data), backend, None
    except ModelUnavailable as e:
        other = fallback_for(backend)
        if other is None:
            raise
        name = "Claude" if other == "claude" else "the check without a model"
        return generate(other, data), other, f"Gemma couldn't be used ({e}), so {name} wrote this feedback."


def generate(backend: str, data: dict) -> dict:
    if backend == "claude":
        raw = _claude(data)
    elif backend == "gemma4-ft":
        raw = _ollama(config.OLLAMA_MODEL_FT, data)
    elif backend == "gemma4-base":
        raw = _ollama(config.OLLAMA_MODEL_BASE, data)
    elif backend == "rules":
        raw = _rules(data)
    elif backend.startswith("ollama:"):
        # Any local Ollama model, for trying the analysis (scripts/try_analysis.py). Not offered in the app.
        raw = _ollama(backend.split(":", 1)[1], data)
    else:
        raise FeedbackError(f"Unknown feedback model: {backend}")

    try:
        fb = Feedback.model_validate(raw)
    except Exception as e:
        raise FeedbackError("The feedback model returned output that does not match the schema.") from e
    fb = fb.model_dump()
    filler_method = "list" if backend == "rules" else "llm"
    # The fine-tuned filler classifier, when configured, decides the fillers; otherwise the model's list stands.
    found = filler_model.find(data["transcript"])
    if found is not None:
        fb["filler_occurrences"], filler_method = found, "model"
    return _sanitize(fb, data, filler_method=filler_method, points_method="words" if backend == "rules" else "llm")


# ---- Backends --------------------------------------------------------------


def _user_message(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False)


def _claude(data: dict) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    try:
        response = client.beta.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=16000,
            system=PROMPT,
            messages=[{"role": "user", "content": _user_message(data)}],
            output_config={
                "effort": "medium",
                "format": {"type": "json_schema", "schema": SCHEMA},
            },
            # On a policy decline, the API retries on its default fallback model.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.AuthenticationError as e:
        raise FeedbackError("Claude API key is missing or invalid on the server.") from e
    except anthropic.RateLimitError as e:
        raise FeedbackError("Claude is rate limited right now. Try again in a minute.") from e
    except anthropic.APIStatusError as e:
        raise FeedbackError(f"Claude API error ({e.status_code}).") from e
    except anthropic.APIConnectionError as e:
        raise FeedbackError("Could not reach the Claude API. Is the server online?") from e

    if response.stop_reason == "refusal":
        raise FeedbackError("Claude declined to give feedback on this pitch.")
    if response.stop_reason == "max_tokens":
        raise FeedbackError("Claude's feedback was cut off. Try a shorter recording.")
    text = next((b.text for b in response.content if b.type == "text"), "")
    return _parse_json(text)


# Measured on a 23-slide Mongolian pitch: about 2.8 characters per token, and answers of up to
# ~5,200 tokens. Estimate a little high so the answer always has room.
_CHARS_PER_TOKEN = 2.5
_ANSWER_TOKENS = 6144
_MIN_CTX = 8192


def num_ctx_for(prompt_chars: int, limit: int | None = None) -> int:
    """Context window for a prompt of this many characters: room for the answer, rounded up to 2048."""
    limit = limit or config.OLLAMA_NUM_CTX_MAX
    need = int(prompt_chars / _CHARS_PER_TOKEN) + _ANSWER_TOKENS
    rounded = -(-need // 2048) * 2048
    return max(_MIN_CTX, min(rounded, limit))


def _ollama(model: str, data: dict) -> dict:
    user = _user_message(data)
    payload = {
        "model": model,
        "stream": False,
        "format": SCHEMA,
        "keep_alive": config.OLLAMA_KEEP_ALIVE,
        "options": {"temperature": 0, "num_ctx": num_ctx_for(len(PROMPT) + len(user))},
        "messages": [
            {"role": "system", "content": PROMPT},
            {"role": "user", "content": user},
        ],
    }
    try:
        headers = {"Authorization": f"Bearer {config.OLLAMA_TOKEN}"} if config.OLLAMA_TOKEN else None
        r = httpx.post(f"{config.OLLAMA_URL}/api/chat", json=payload, headers=headers, timeout=config.OLLAMA_TIMEOUT_S)
    except httpx.HTTPError as e:
        raise ModelUnavailable("Could not reach Ollama. Is it running on this machine?") from e
    if r.status_code == 404:
        raise ModelUnavailable(f"Ollama does not have the model '{model}'. Pull or create it first.")
    if r.status_code in (401, 403, 502, 503, 504):
        raise ModelUnavailable(f"Ollama isn't reachable through the voice server (HTTP {r.status_code}).")
    if r.status_code != 200:
        raise FeedbackError(f"Ollama error ({r.status_code}).")
    body = r.json()
    if body.get("done_reason") == "length":
        # The prompt and answer didn't fit the context window, so the JSON was cut off.
        raise FeedbackError(
            "The feedback model ran out of room: the recording and slides are too long for it. "
            "Try fewer slides or a shorter recording."
        )
    return _parse_json(body.get("message", {}).get("content", ""))


def _parse_json(text: str) -> dict:
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise FeedbackError("The feedback model did not return valid JSON.") from e


def number_ranges(numbers: list[int]) -> str:
    """[1, 3, 4, 5, 6] -> "1, 3–6": runs of three or more consecutive numbers become ranges."""
    nums = sorted(set(numbers))
    parts: list[str] = []
    i = 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        parts.append(f"{nums[i]}–{nums[j]}" if j - i >= 2 else ", ".join(map(str, nums[i : j + 1])))
        i = j + 1
    return ", ".join(parts)


def _rules(data: dict) -> dict:
    """Measurement-only feedback. No content scores, so Content is left out of the score."""
    m, w = data["metrics"], data["wording"]
    recs = []
    if m.get("wpm") and m["wpm"] > 150:
        recs.append(("delivery", f"Минутанд {m['wpm']:.0f} үг хэлсэн нь хурдан байна.", "Гол санаа, тооны дараа 1 секунд завсарла.", "medium"))
    if m.get("wpm") and m["wpm"] < 110:
        recs.append(("delivery", f"Минутанд {m['wpm']:.0f} үг хэлсэн нь удаан байна.", "Өгүүлбэр хоорондын завсарлагыг богиносго.", "medium"))
    if w.get("fillers_per_100") and w["fillers_per_100"] > 2:
        recs.append(("delivery", f"100 үг тутамд {w['fillers_per_100']} дүүргэгч үг хэлсэн.", "Дүүргэгч үгийн оронд чимээгүй завсарла.", "high"))
    point_checks = points.rules_check([p["text"] for p in data["pitch"]["key_points"]], data["transcript"])
    for c in [c for c in point_checks if c["status"] != "covered"][:2]:
        text = data["pitch"]["key_points"][c["point"]]["text"]
        recs.append(("content", f"Гол санаа ярианд тод сонсогдсонгүй: «{text}».", "Энэ санааг нэг тодорхой өгүүлбэрээр, баримт эсвэл жишээтэй хэл.", "high"))
    missed = [a["slide"] for a in data["alignment"] if a["status"] == "missed"]
    if missed:
        recs.append(("slides", f"{number_ranges(missed)}-р слайдын агуулгыг яриандаа хэлээгүй.", "Слайд бүрийн гол санааг нэг өгүүлбэрээр хэл.", "high"))

    recommendations = [
        {"area": area, "problem": problem, "start_s": None, "slide": None, "why": "", "action": action, "example_sentence": "", "impact": impact}
        for area, problem, action, impact in recs
    ]
    return {
        "summary": "Энэ зөвлөгөө зөвхөн хэмжилт дээр үндэслэсэн. Агуулгын үнэлгээ хийгдээгүй.",
        "strengths": [],
        "content_scores": [],
        "slide_feedback": [{"slide": a["slide"], "status": a["status"], "comment": ""} for a in data["alignment"]],
        "number_checks": [
            {"slide": c["slide"], "on_slide": c["on_slide"], "said": None, "inconsistent": False}
            for c in data["number_candidates"]
        ],
        "recommendations": recommendations,
        "practice_tasks": _rules_practice_tasks(recommendations),
        # Without a model, every listed filler counts.
        "filler_occurrences": data["filler_candidates"],
        # Without a model, main points are matched by key words.
        "point_checks": point_checks,
        "off_topic": [],
        "idea_comment": "",
    }


def _rules_practice_tasks(recommendations: list[dict]) -> list[dict]:
    """Turn measurable recommendations into short exercises; add neutral drills if needed."""
    titles = {
        "structure": "Бүтцийн дасгал",
        "content": "Агуулгын дасгал",
        "delivery": "Ярианы дасгал",
        "slides": "Слайдын дасгал",
        "accuracy": "Нарийвчлалын дасгал",
        "timing": "Хугацааны дасгал",
    }
    goals = {
        "structure": "Санаагаа дараалалтай, ойлгомжтой хүргэх.",
        "content": "Гол санаагаа баримт эсвэл жишээгээр тодруулах.",
        "delivery": "Ярианы хэмнэл, завсарлагаа тохируулах.",
        "slides": "Слайд бүрийн гол санааг яриатай холбох.",
        "accuracy": "Слайд дахь тоо, мэдээллийг зөв дамжуулах.",
        "timing": "Илтгэлээ төлөвлөсөн хугацаанд багтаах.",
    }
    tasks = []
    seen = set()
    for recommendation in recommendations:
        area = recommendation["area"]
        title = titles.get(area, "Дадлагын дасгал")
        if title in seen:
            continue
        seen.add(title)
        tasks.append({
            "title": title,
            "instruction": recommendation["action"],
            "goal": goals.get(area, "Ярианы нэг чадварыг сайжруулах."),
        })
        if len(tasks) == 3:
            break

    defaults = [
        {
            "title": "Гол санаагаа цэгцлэх",
            "instruction": "Илтгэлийнхээ гол санааг 30 секундэд багтаан ярьж бич.",
            "goal": "Сонсогчид илтгэлийн гол санааг товч ойлгуулах.",
        },
        {
            "title": "Төгсгөлөө давтах",
            "instruction": "Илтгэлийн төгсгөлд хэлэх гол дүгнэлтээ нэг өгүүлбэрээр давтан хэл.",
            "goal": "Илтгэлийн гол санааг тодорхой төгсгөх.",
        },
    ]
    for task in defaults:
        if len(tasks) >= 2:
            break
        if task["title"] not in seen:
            tasks.append(task)
            seen.add(task["title"])
    return tasks


# ---- Checks on model output ------------------------------------------------


STILL_OPEN = "Өмнөх бичлэгээс хойш хэвээр:"


def _stems(text: str) -> set[str]:
    """Word beginnings: Mongolian adds suffixes, so "хэрэглэгч" and "хэрэглэгчийг" share "хэрэг"."""
    return {w[:5] for w in re.findall(r"[\w-]+", text.lower()) if len(w) >= 4}


def same_problem(a: str, b: str) -> bool:
    """Whether two fixes describe the same problem: most of the shorter one's word stems are shared."""
    sa, sb = _stems(a), _stems(b)
    shared = sa & sb
    return len(shared) >= 2 and len(shared) >= 0.6 * min(len(sa), len(sb))


def mark_still_open(recommendations: list[dict], previous_takes: list[dict]) -> None:
    """Start a fix that the newest earlier take was also given with STILL_OPEN (unless it already does)."""
    earlier = previous_takes[0]["fixes"] if previous_takes else []
    for r in recommendations:
        problem = r.get("problem") or ""
        if problem and not problem.startswith(STILL_OPEN) and any(same_problem(problem, e) for e in earlier):
            r["problem"] = f"{STILL_OPEN} {problem}"


def _sanitize(fb: dict, data: dict, filler_method: str = "llm", points_method: str = "llm") -> dict:
    starts = [s["start"] for s in data["transcript"]]
    slide_numbers = {s["number"] for s in data["slides"]}
    criteria = data["criteria"]
    alignment = {a["slide"]: a["status"] for a in data["alignment"]}
    candidates = {(c["slide"], c["on_slide"]) for c in data["number_candidates"]}

    def snap_start(t):
        if t is None or not starts:
            return None
        nearest = min(starts, key=lambda s: abs(s - t))
        return nearest if abs(nearest - t) <= 1.0 else None

    scores = {}
    for c in fb["content_scores"]:
        if c["criterion"] in criteria and c["criterion"] not in scores:
            c["score"] = max(0, min(100, int(c["score"])))
            scores[c["criterion"]] = c
    fb["content_scores"] = [scores[k] for k in criteria if k in scores]

    # Status always comes from the alignment code; the model only adds comments.
    comments = {s["slide"]: s["comment"] for s in fb["slide_feedback"]}
    fb["slide_feedback"] = [{"slide": n, "status": st, "comment": comments.get(n, "")} for n, st in alignment.items()]

    # The model lists only the figures the speaker mentioned; every other candidate is added here as
    # never said, so the report still has one entry per candidate, in the candidates' order.
    given = {(n["slide"], n["on_slide"]): n for n in fb["number_checks"] if (n["slide"], n["on_slide"]) in candidates}
    checks, seen = [], set()
    for c in data["number_candidates"]:
        key = (c["slide"], c["on_slide"])
        if key in seen:
            continue
        seen.add(key)
        checks.append(given.get(key) or {"slide": key[0], "on_slide": key[1], "said": None, "inconsistent": False})
    fb["number_checks"] = checks

    recs = fb["recommendations"][:MAX_RECOMMENDATIONS]
    mark_still_open(recs, data.get("previous_takes") or [])
    for r in recs:
        r["start_s"] = snap_start(r["start_s"])
        if r["slide"] not in slide_numbers:
            r["slide"] = None
    fb["recommendations"] = recs

    # Fillers: keep only occurrences that exist in the named sentence; counts come from code.
    sentences = data["transcript"]
    reported = len(fb["filler_occurrences"])
    fb["filler_occurrences"] = fillers.verify(fb["filler_occurrences"], sentences)
    fb["fillers"] = fillers.summarize(
        fb["filler_occurrences"], sentences, data["wording"].get("word_count") or 0, filler_method
    )
    # How many occurrences the model claimed before verification; the gap is what it invented.
    fb["fillers"]["model_reported"] = reported

    # Main points: quotes are checked against the transcript and coverage is computed in code.
    fb["main_points"] = points.verify(
        fb["point_checks"], [p["text"] for p in data["pitch"]["key_points"]], sentences,
        fb["off_topic"], fb["idea_comment"], points_method,
        idea=data["pitch"]["idea"] or "",
    )
    return fb

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
from pathlib import Path
from typing import Literal, Optional

import httpx
from pydantic import BaseModel, ConfigDict

from . import config

Backend = Literal["claude", "gemma4-ft", "gemma4-base", "rules"]
BACKENDS: tuple[str, ...] = ("claude", "gemma4-ft", "gemma4-base", "rules")

PROMPT = (Path(__file__).parent / "prompts" / "feedback_v2.md").read_text(encoding="utf-8")
MAX_RECOMMENDATIONS = 5
SLIDE_WORDS = 60  # trim slide text so a 3-minute pitch plus 10 slides fits in 6144 tokens

CRITERIA = {
    "startup": ["problem", "solution", "target_user", "value", "logical_order", "conclusion_cta"],
    "academic": ["research_question", "method", "results", "contribution", "logical_order", "conclusion"],
}


class FeedbackError(Exception):
    pass


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


class Feedback(_Strict):
    summary: str
    strengths: list[str]
    content_scores: list[ContentScore]
    slide_feedback: list[SlideFeedback]
    number_checks: list[NumberCheck]
    recommendations: list[Recommendation]


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
    return {
        "session": session,
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
    }


def generate(backend: str, data: dict) -> dict:
    if backend == "claude":
        raw = _claude(data)
    elif backend == "gemma4-ft":
        raw = _ollama(config.OLLAMA_MODEL_FT, data)
    elif backend == "gemma4-base":
        raw = _ollama(config.OLLAMA_MODEL_BASE, data)
    elif backend == "rules":
        raw = _rules(data)
    else:
        raise FeedbackError(f"Unknown feedback model: {backend}")

    try:
        fb = Feedback.model_validate(raw)
    except Exception as e:
        raise FeedbackError("The feedback model returned output that does not match the schema.") from e
    return _sanitize(fb.model_dump(), data)


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


def _ollama(model: str, data: dict) -> dict:
    payload = {
        "model": model,
        "stream": False,
        "format": SCHEMA,
        "options": {"temperature": 0, "num_ctx": 8192},
        "messages": [
            {"role": "system", "content": PROMPT},
            {"role": "user", "content": _user_message(data)},
        ],
    }
    try:
        r = httpx.post(f"{config.OLLAMA_URL}/api/chat", json=payload, timeout=config.OLLAMA_TIMEOUT_S)
    except httpx.HTTPError as e:
        raise FeedbackError("Could not reach Ollama. Is it running on this machine?") from e
    if r.status_code == 404:
        raise FeedbackError(f"Ollama does not have the model '{model}'. Pull or create it first.")
    if r.status_code != 200:
        raise FeedbackError(f"Ollama error ({r.status_code}).")
    return _parse_json(r.json().get("message", {}).get("content", ""))


def _parse_json(text: str) -> dict:
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise FeedbackError("The feedback model did not return valid JSON.") from e


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
    missed = [a["slide"] for a in data["alignment"] if a["status"] == "missed"]
    if missed:
        recs.append(("slides", f"{', '.join(map(str, missed))}-р слайдын агуулгыг яриандаа хэлээгүй.", "Слайд бүрийн гол санааг нэг өгүүлбэрээр хэл.", "high"))

    return {
        "summary": "Энэ зөвлөгөө зөвхөн хэмжилт дээр үндэслэсэн. Агуулгын үнэлгээ хийгдээгүй.",
        "strengths": [],
        "content_scores": [],
        "slide_feedback": [{"slide": a["slide"], "status": a["status"], "comment": ""} for a in data["alignment"]],
        "number_checks": [
            {"slide": c["slide"], "on_slide": c["on_slide"], "said": None, "inconsistent": False}
            for c in data["number_candidates"]
        ],
        "recommendations": [
            {"area": area, "problem": problem, "start_s": None, "slide": None, "why": "", "action": action, "example_sentence": "", "impact": impact}
            for area, problem, action, impact in recs
        ],
    }


# ---- Checks on model output ------------------------------------------------


def _sanitize(fb: dict, data: dict) -> dict:
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

    fb["number_checks"] = [n for n in fb["number_checks"] if (n["slide"], n["on_slide"]) in candidates]

    recs = fb["recommendations"][:MAX_RECOMMENDATIONS]
    for r in recs:
        r["start_s"] = snap_start(r["start_s"])
        if r["slide"] not in slide_numbers:
            r["slide"] = None
    fb["recommendations"] = recs
    return fb

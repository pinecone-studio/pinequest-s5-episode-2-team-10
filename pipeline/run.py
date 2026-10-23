"""Run the whole analysis for one session: transcribe, measure, align slides, feedback, score."""

from pathlib import Path
from typing import Callable

from . import alignment, asr, feedback, metrics, scoring, segments, text_checks

Stage = Callable[[str], None]


def analyze(
    wav: Path,
    duration_s: float,
    session: dict,
    slides: list[dict],
    backend: str,
    on_stage: Stage = lambda _: None,
) -> dict:
    notes: list[str] = []

    on_stage("transcribing")
    words, asr_backend = asr.transcribe(wav)
    asr.unload()  # free the GPU before the feedback model runs
    if asr_backend == "stub":
        notes.append("Transcript is sample text (PITCH_ASR=stub), not your speech.")
    elif asr_backend == "duudlaga":
        notes.append("Word timings are estimated; Duudlaga batch STT returns text only.")
    elif asr_backend in ("whisper", "remote"):
        notes.append("Word timings are estimated from where the audio has sound; the speech model returns text only.")
    if not words:
        raise ValueError("No speech was found in the recording.")
    sentences = segments.to_sentences(words)

    on_stage("measuring")
    measured = metrics.measure(wav, words, duration_s)
    wording = text_checks.check(sentences)

    on_stage("slides")
    aligned = alignment.align(sentences, slides)
    if aligned["method"] == "overlap" and slides:
        notes.append("Slides were matched by key words only (embedding model not loaded).")

    on_stage("feedback")
    data = feedback.build_input(session, sentences, measured, wording, slides, aligned)
    fb = feedback.generate(backend, data)

    on_stage("scoring")
    # Score fillers on the occurrences confirmed in context, not the raw word-list matches.
    # The list numbers stay alongside for evaluation.
    fill = fb["fillers"]
    wording = {
        **wording,
        "list_fillers": wording["fillers"],
        "list_filler_total": wording["filler_total"],
        "fillers": {w["word"]: w["count"] for w in fill["words"]},
        "filler_total": fill["total"],
        "fillers_per_100": fill["per_100"],
        "filler_method": fill["method"],
    }
    confirmed = sum(1 for n in fb["number_checks"] if n["inconsistent"])
    scores = scoring.compute(
        fb["content_scores"], measured, wording, aligned["coverage"], confirmed, session.get("planned_s")
    )

    return {
        "scores": scores,
        "metrics": {**measured, "fillers_per_100": wording["fillers_per_100"]},
        "wording": wording,
        "alignment": aligned,
        "feedback": fb,
        "words": words,
        "sentences": sentences,
        "asr_backend": asr_backend,
        "notes": notes,
        "prompt_version": feedback.PROMPT_VERSION,
    }

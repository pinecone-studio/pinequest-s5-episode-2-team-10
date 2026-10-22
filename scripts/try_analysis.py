"""Try the AI analysis on a transcript, without audio, speech recognition, the server or the UI.

Examples (run from the repo root):
  python -m scripts.try_analysis                                   # sample transcript, rules (no model)
  python -m scripts.try_analysis --backend ollama:qwen3:8b         # any local Ollama model
  python -m scripts.try_analysis --backend claude                  # needs ANTHROPIC_API_KEY (paid)
  python -m scripts.try_analysis --text my_pitch.txt --slides deck.pdf --runs 3 --json out.json

The transcript is plain text; sentences are split at . ! ? or new lines and given estimated
timestamps (140 words per minute). There is no audio, so pace, pauses, pitch and volume are
empty and Delivery reflects filler words only.
"""

import argparse
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

from pipeline import alignment, feedback, fillers, scoring, slides as slide_tools, text_checks
from pipeline.tokens import tokens

SAMPLE = Path(__file__).parent / "samples" / "pitch_fillers.txt"
WORDS_PER_SECOND = 140 / 60


def to_sentences(text: str) -> list[dict]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?…])\s+|\n+", text) if p.strip()]
    out, t = [], 0.0
    for p in parts:
        dur = max(1.0, len(tokens(p)) / WORDS_PER_SECOND)
        out.append({"text": p, "start": round(t, 1), "end": round(t + dur, 1)})
        t += dur + 0.4
    return out


def run_once(backend: str, session: dict, sentences: list[dict], deck: list[dict]) -> tuple[dict, dict, float]:
    wording = text_checks.check(sentences)
    duration = sentences[-1]["end"] if sentences else 0
    metrics = {"duration_s": duration, "wpm": None, "long_pauses_per_min": None,
               "pitch_range_st": None, "end_volume_drop_db": None}
    aligned = alignment.align(sentences, deck)
    data = feedback.build_input(session, sentences, metrics, wording, deck, aligned)

    started = time.time()
    fb = feedback.generate(backend, data)
    seconds = time.time() - started

    fill = fb["fillers"]
    wording = {**wording, "fillers_per_100": fill["per_100"]}
    confirmed = sum(1 for n in fb["number_checks"] if n["inconsistent"])
    scores = scoring.compute(fb["content_scores"], metrics, wording, aligned["coverage"], confirmed, session["planned_s"])
    return {"feedback": fb, "scores": scores, "candidates": data["filler_candidates"]}, aligned, seconds


def print_fillers(result: dict, sentences: list[dict]) -> None:
    fill = result["feedback"]["fillers"]
    kept = Counter((o["sentence_id"], o["word"]) for o in result["feedback"]["filler_occurrences"])
    listed = Counter((c["sentence_id"], c["word"]) for c in result["candidates"])

    print(f"\nFILLER WORDS  ({fill['method']})")
    print(f"  word list found {sum(listed.values())}, model reported {fill.get('model_reported')}, "
          f"verified {fill['total']}  ->  {fill['per_100']} per 100 words")
    for w in fill["words"]:
        print(f"  “{w['word']}” ×{w['count']}")

    dropped = listed - kept
    added = kept - listed
    if dropped:
        print("  Dropped by the model (judged meaningful in context):")
        for (sid, word), n in sorted(dropped.items()):
            print(f"    sentence {sid + 1}: “{word}”{' ×' + str(n) if n > 1 else ''}  —  {sentences[sid]['text']}")
    if added:
        print("  Added by the model (not on the word list):")
        for (sid, word), n in sorted(added.items()):
            print(f"    sentence {sid + 1}: “{word}”{' ×' + str(n) if n > 1 else ''}  —  {sentences[sid]['text']}")
    invented = (fill.get("model_reported") or 0) - fill["total"]
    if invented > 0:
        print(f"  Removed by verification (not in the named sentence): {invented}")
    if fill["note"]:
        print(f"  Note: {fill['note']}")


def print_rest(result: dict, fillers_only_delivery: bool = True) -> None:
    fb, sc = result["feedback"], result["scores"]
    print("\nSCORES")
    print(f"  overall {sc['overall']}  (based on {sc['categories_used']} of 4)  |  content {sc['content']}  "
          f"delivery {sc['delivery']}{' (fillers only)' if fillers_only_delivery else ''}  slides {sc['slide_alignment']}  timing {sc['timing']}")
    if fb["content_scores"]:
        print("\nCONTENT")
        for c in fb["content_scores"]:
            print(f"  {c['criterion']:<16} {c['score']:>3}  {c['recommendation']}")
    print(f"\nSUMMARY\n  {fb['summary']}")
    if fb["recommendations"]:
        print("\nRECOMMENDATIONS")
        for i, r in enumerate(fb["recommendations"], 1):
            where = f" at {r['start_s']}s" if r["start_s"] is not None else ""
            print(f"  {i}. [{r['impact']}] {r['problem']}{where}\n     -> {r['action']}")
            if r["example_sentence"]:
                print(f"     e.g. {r['example_sentence']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", default="rules", help="rules | claude | gemma4-ft | gemma4-base | ollama:<model>")
    ap.add_argument("--text", type=Path, default=SAMPLE, help="transcript as plain text (default: sample)")
    ap.add_argument("--script", type=Path, help="planned script, plain text")
    ap.add_argument("--slides", type=Path, help="PDF or PPTX")
    ap.add_argument("--pitch-type", choices=["startup", "academic"], default="startup")
    ap.add_argument("--planned-s", type=int, default=60)
    ap.add_argument("--runs", type=int, default=1, help="repeat to check how consistent the model is")
    ap.add_argument("--json", type=Path, help="write the full results here")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)  # show progress even when output is redirected

    sentences = to_sentences(args.text.read_text(encoding="utf-8"))
    if not sentences:
        print("The transcript is empty.")
        return 1
    deck = slide_tools.extract(args.slides) if args.slides else []
    session = {
        "title": args.text.stem, "goal": "", "audience": "", "planned_s": args.planned_s,
        "pitch_type": args.pitch_type, "script": args.script.read_text(encoding="utf-8") if args.script else "",
    }
    print(f"{len(sentences)} sentences, {sum(len(tokens(s['text'])) for s in sentences)} words, "
          f"{len(deck)} slides, backend {args.backend}")

    results = []
    for i in range(args.runs):
        try:
            result, _, seconds = run_once(args.backend, session, sentences, deck)
        except feedback.FeedbackError as e:
            print(f"\nFeedback failed: {e}")
            return 1
        results.append(result)
        print(f"\n===== run {i + 1}/{args.runs}  ({seconds:.1f} s) =====")
        print_fillers(result, sentences)
        if i == 0:
            print_rest(result)

    if args.runs > 1:
        totals = [r["feedback"]["fillers"]["total"] for r in results]
        contents = [r["scores"]["content"] for r in results if r["scores"]["content"] is not None]
        print("\nCONSISTENCY")
        print(f"  filler totals per run: {totals}")
        if contents:
            print(f"  content score per run: {contents}  (spread {max(contents) - min(contents)})")

    if args.json:
        args.json.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nFull results written to {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

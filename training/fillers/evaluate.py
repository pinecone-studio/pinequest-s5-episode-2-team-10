"""How well each method finds filler words, measured against hand labels.

    # the word list alone (no model, instant)
    python -m training.fillers.evaluate --labels data/fillers/labels.jsonl
    # list + the app's feedback models (same prompt and checks as the app)
    python -m training.fillers.evaluate --labels data/fillers/labels.jsonl --backend gemma4-base --backend claude
    # any other method, e.g. a trained classifier: JSONL rows {"pitch", "sentence_id", "word"}
    python -m training.fillers.evaluate --labels data/fillers/labels.jsonl --predictions data/fillers/clf.jsonl

Only rows marked "checked" in label.html count. Scores are per token: a missed "ээ" is one false
negative, a "тэгээд" that means "and then" but was flagged is one false positive.
"""

import argparse
import json
import sys
from pathlib import Path

from pipeline import feedback, fillers
from training.speed.make_data import build

from . import labels

SESSION = {"title": "", "goal": "", "audience": "шүүгчид", "planned_s": 120, "pitch_type": "startup"}


def from_occurrences(pitch_rows: list[dict], occurrences: list[dict]) -> dict[tuple[str, int], set[int]]:
    """Place {sentence_id, word} occurrences (list or model output) at token positions."""
    out = {}
    for row in pitch_rows:
        words = [o["word"] for o in occurrences if o.get("sentence_id") == row["sentence_id"]]
        out[(row["pitch"], row["sentence_id"])] = labels.positions(row["tokens"], words)
    return out


def predict_list(pitch_rows: list[dict]) -> dict[tuple[str, int], set[int]]:
    sentences = [{"text": r["text"], "start": 0.0} for r in pitch_rows]
    return from_occurrences(pitch_rows, fillers.find_candidates(sentences))


def predict_backend(backend: str, pitch_rows: list[dict]) -> dict[tuple[str, int], set[int]] | None:
    """The app's analysis on this pitch; None when the pitch is too short or the model fails."""
    # One line per sentence, so the splitter gives back exactly the labelled sentences.
    data = build("\n".join(r["text"] for r in pitch_rows), {**SESSION, "title": pitch_rows[0]["pitch"]})
    if data is None:
        return None
    fb = feedback.generate(backend, data)
    return from_occurrences(pitch_rows, fb["filler_occurrences"])


def predict_file(path: Path, rows: list[dict]) -> dict[tuple[str, int], set[int]]:
    """Rows {pitch, sentence_id, word}; an exact "token_idx" (classifier output) is used as given."""
    occ: dict[str, list[dict]] = {}
    exact: dict[tuple[str, int], set[int]] = {}
    for p in labels.read(path):
        if "token_idx" in p:
            exact.setdefault((p["pitch"], p["sentence_id"]), set()).add(p["token_idx"])
        else:
            occ.setdefault(p["pitch"], []).append(p)
    out = {k: v for pitch, pitch_rows in labels.by_pitch(rows).items()
           for k, v in from_occurrences(pitch_rows, occ.get(pitch, [])).items()}
    for key, idx in exact.items():
        out[key] = out.get(key, set()) | idx
    return out


def fmt(x: float | None) -> str:
    return "  -  " if x is None else f"{x:.3f}"


def report(name: str, result: dict, pitches: int, top: int) -> None:
    print(f"{name:<16} {pitches:>4} {result['tp']:>5} {result['fp']:>5} {result['fn']:>5}"
          f"  {fmt(result['precision'])}  {fmt(result['recall'])}  {fmt(result['f1'])}")
    worst = sorted(result["per_word"].items(), key=lambda kv: -(kv[1]["fp"] + kv[1]["fn"]))[:top]
    for word, c in worst:
        if c["fp"] or c["fn"]:
            print(f"{'':<16}   {word}: missed {c['fn']}, wrongly flagged {c['fp']}, found {c['tp']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--labels", type=Path, default=Path("data/fillers/labels.jsonl"))
    ap.add_argument("--backend", action="append", default=[],
                    help=f"feedback model to test, repeatable: {', '.join(feedback.BACKENDS)} or ollama:<model>")
    ap.add_argument("--predictions", type=Path, action="append", default=[], help="JSONL of {pitch, sentence_id, word}")
    ap.add_argument("--include-unchecked", action="store_true", help="also count rows not yet checked by hand")
    ap.add_argument("--top", type=int, default=5, help="words with the most errors to show per method")
    ap.add_argument("--out", type=Path, help="also save the full results as JSON")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    rows = [r for r in labels.read(args.labels) if args.include_unchecked or r.get("checked")]
    if not rows:
        print("no checked rows yet: mark sentences as checked in label.html, or pass --include-unchecked")
        return 1
    pitches = labels.by_pitch(rows)
    gold_total = sum(len(r["filler_idx"]) for r in rows)
    words = sum(len(r["tokens"]) for r in rows)
    print(f"{len(pitches)} pitches, {len(rows)} sentences, {words} words, {gold_total} hand-labelled filler tokens "
          f"({gold_total / words * 100:.2f} per 100 words)\n")
    print(f"{'method':<16} {'pit':>4} {'tp':>5} {'fp':>5} {'fn':>5}  {'prec':>5}  {'rec':>5}  {'f1':>5}")

    results = {}
    predicted = {k: v for pr in pitches.values() for k, v in predict_list(pr).items()}
    results["list"] = labels.score(rows, predicted)
    report("list", results["list"], len(pitches), args.top)

    for backend in args.backend:
        predicted, covered = {}, []
        for n, (pitch, pitch_rows) in enumerate(pitches.items(), 1):
            try:
                pred = predict_backend(backend, pitch_rows)
            except Exception as e:  # a failed answer is reported, not fatal: the other pitches still count
                print(f"  {backend} {n}/{len(pitches)} {pitch}: failed ({type(e).__name__}: {e})")
                continue
            if pred is None:
                print(f"  {backend} {n}/{len(pitches)} {pitch}: fewer than 3 sentences, skipped")
                continue
            predicted.update(pred)
            covered += pitch_rows
        results[backend] = labels.score(covered, predicted)
        report(backend, results[backend], len({r["pitch"] for r in covered}), args.top)

    for path in args.predictions:
        results[path.stem] = labels.score(rows, predict_file(path, rows))
        report(path.stem, results[path.stem], len(pitches), args.top)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nsaved -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

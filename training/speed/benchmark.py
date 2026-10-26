"""Is the fine-tuned E2B faster, and still good? Compares models on held-out pitches (test.jsonl).

    python -m training.speed.benchmark --models gemma4:e4b pitchcoach-e2b --data data/speed

For each model: seconds per answer, answer tokens and tokens per second, how often the answer
passes the schema, and agreement with the teacher's answer (content scores, filler words).
Run it on the machine that will serve the model (the 4060), so the speed numbers mean something.
"""

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

import httpx

from pipeline import config, feedback


def ask(model: str, messages: list[dict]) -> tuple[dict | None, dict]:
    headers = {"Authorization": f"Bearer {config.OLLAMA_TOKEN}"} if config.OLLAMA_TOKEN else None
    started = time.monotonic()
    r = httpx.post(f"{config.OLLAMA_URL}/api/chat", headers=headers, timeout=600, json={
        "model": model, "stream": False, "format": feedback.SCHEMA, "think": False,
        "options": {"temperature": 0, "num_ctx": 8192}, "messages": messages,
    })
    r.raise_for_status()
    d = r.json()
    ns = 1e9
    stats = {"seconds": time.monotonic() - started, "tokens": d.get("eval_count") or 0,
             "tok_s": (d.get("eval_count") or 0) / max(1e-9, (d.get("eval_duration") or 1) / ns),
             "load_s": (d.get("load_duration") or 0) / ns}
    try:
        answer = json.loads(d.get("message", {}).get("content", ""))
        feedback.Feedback.model_validate(answer)
        return answer, stats
    except Exception:
        return None, stats


def agreement(answer: dict, reference: dict) -> tuple[float | None, float | None]:
    """Mean absolute difference of content scores, and filler-occurrence overlap (F1)."""
    a = {c["criterion"]: c["score"] for c in answer.get("content_scores", [])}
    b = {c["criterion"]: c["score"] for c in reference.get("content_scores", [])}
    shared = a.keys() & b.keys()
    mae = statistics.mean(abs(a[k] - b[k]) for k in shared) if shared else None
    fa = {(o["sentence_id"], o["word"]) for o in answer.get("filler_occurrences", [])}
    fb = {(o["sentence_id"], o["word"]) for o in reference.get("filler_occurrences", [])}
    f1 = (2 * len(fa & fb) / (len(fa) + len(fb))) if (fa or fb) else None
    return mae, f1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--data", type=Path, default=Path("data/speed"))
    ap.add_argument("--limit", type=int, default=30)
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    rows = [json.loads(line) for line in (args.data / "test.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = rows[: args.limit]
    print(f"{len(rows)} held-out pitches\n")
    for model in args.models:
        ask(model, rows[0]["messages"][:2])  # load the model first; not counted
        secs, toks, rates, valid, maes, f1s = [], [], [], 0, [], []
        for row in rows:
            answer, s = ask(model, row["messages"][:2])
            secs.append(s["seconds"]); toks.append(s["tokens"]); rates.append(s["tok_s"])
            if answer is not None:
                valid += 1
                mae, f1 = agreement(answer, json.loads(row["messages"][2]["content"]))
                if mae is not None: maes.append(mae)
                if f1 is not None: f1s.append(f1)
        med = statistics.median
        print(f"{model}")
        print(f"  seconds per answer  median {med(secs):.1f}  (max {max(secs):.1f})")
        print(f"  answer tokens       median {med(toks):.0f}   speed {med(rates):.1f} tokens/s")
        print(f"  valid answers       {valid}/{len(rows)}")
        if maes: print(f"  vs teacher          content score difference {statistics.mean(maes):.1f} points, filler F1 {statistics.mean(f1s) if f1s else float('nan'):.2f}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())

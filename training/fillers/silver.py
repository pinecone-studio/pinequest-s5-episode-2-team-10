"""Silver labels: a feedback model marks the fillers, so a small classifier can be trained without
waiting for hand labels. Same row format as the hand-labelling sheet, with "source" set.

    # real transcripts (one .txt per pitch, with consent)
    python -m training.fillers.silver --transcripts data/transcripts --out data/fillers/silver.jsonl
    # plus synthetic pitches written by the teacher, many with fillers on purpose
    python -m training.fillers.silver --synthetic 300 --out data/fillers/silver.jsonl

Needs the backend to be reachable (gemma4-base: Ollama at OLLAMA_URL; claude: ANTHROPIC_API_KEY).
Rows are appended as they arrive, so a stopped run keeps its work; rerunning skips finished pitches.
Silver labels copy the teacher's mistakes: test only on hand-checked rows (label.html).
"""

import argparse
import json
import random
import sys
from pathlib import Path

from pipeline import config
from training.speed.make_data import synthetic_pitch

from . import evaluate, labels, sheet


def label_pitch(backend: str, pitch: str, text: str) -> list[dict] | None:
    rows = sheet.rows_for(pitch, text)
    predicted = evaluate.predict_backend(backend, rows)
    if predicted is None:
        return None
    for row in rows:
        row["filler_idx"] = sorted(predicted[(pitch, row["sentence_id"])])
        row["source"] = backend
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--transcripts", type=Path, help="folder of .txt transcripts")
    ap.add_argument("--synthetic", type=int, default=0, help="also label this many synthetic pitches")
    ap.add_argument("--backend", default="gemma4-base", help="feedback model that labels: gemma4-base, claude, ollama:<model>")
    ap.add_argument("--teacher", default=config.OLLAMA_MODEL_BASE, help="Ollama model that writes synthetic pitches")
    ap.add_argument("--out", type=Path, default=Path("data/fillers/silver.jsonl"))
    ap.add_argument("--seed", type=int, default=11)
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)
    rng = random.Random(args.seed)

    done = {r["pitch"] for r in labels.read(args.out)} if args.out.exists() else set()
    jobs: list[tuple[str, str | None]] = []
    if args.transcripts:
        jobs += [(f.stem, f.read_text(encoding="utf-8")) for f in sorted(args.transcripts.glob("*.txt"))]
    jobs += [(f"synthetic-{i + 1:04d}", None) for i in range(args.synthetic)]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    kept = 0
    with args.out.open("a", encoding="utf-8") as out:
        for n, (pitch, text) in enumerate(jobs, 1):
            if pitch in done:
                continue
            try:
                if text is None:
                    text, _ = synthetic_pitch(args.teacher, rng)
                rows = label_pitch(args.backend, pitch, text)
            except Exception as e:  # one failed pitch shouldn't stop an overnight run
                print(f"{n}/{len(jobs)} {pitch}: failed ({type(e).__name__}), skipped")
                continue
            if rows is None:
                print(f"{n}/{len(jobs)} {pitch}: fewer than 3 sentences, skipped")
                continue
            for row in rows:
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            kept += 1
            print(f"{n}/{len(jobs)} {pitch}: {len(rows)} sentences, {sum(len(r['filler_idx']) for r in rows)} fillers")
    print(f"\nlabelled {kept} new pitches -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Make a labelling sheet: one row per transcript sentence, with the word-list fillers pre-marked.

    python -m training.fillers.sheet --transcripts data/transcripts --out data/fillers/labels.jsonl

Then open training/fillers/label.html in a browser, load the sheet, fix the marks and save.
Sentences are split the same way the evaluation and training scripts split them. Use transcripts
you have consent for; data/ is not committed.
"""

import argparse
import sys
from pathlib import Path

from pipeline import fillers
from pipeline.tokens import tokens
from scripts.try_analysis import to_sentences

from . import labels


def rows_for(pitch: str, text: str) -> list[dict]:
    sentences = to_sentences(text)
    candidates = fillers.find_candidates(sentences)
    rows = []
    for sid, s in enumerate(sentences):
        words = tokens(s["text"])
        marked = labels.positions(words, [c["word"] for c in candidates if c["sentence_id"] == sid])
        rows.append({"pitch": pitch, "sentence_id": sid, "text": s["text"], "tokens": words,
                     "filler_idx": sorted(marked), "checked": False})
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--transcripts", type=Path, required=True, help="folder of .txt transcripts, one per pitch")
    ap.add_argument("--out", type=Path, default=Path("data/fillers/labels.jsonl"))
    ap.add_argument("--force", action="store_true", help="overwrite an existing sheet (loses hand labels)")
    args = ap.parse_args()

    if args.out.exists() and not args.force:
        print(f"{args.out} already exists; it may hold hand labels. Use --force to overwrite.")
        return 1
    files = sorted(args.transcripts.glob("*.txt"))
    if not files:
        print(f"no .txt files in {args.transcripts}")
        return 1

    rows = [r for f in files for r in rows_for(f.stem, f.read_text(encoding="utf-8"))]
    labels.write(args.out, rows)
    marked = sum(len(r["filler_idx"]) for r in rows)
    print(f"{len(files)} pitches, {len(rows)} sentences, {marked} list fillers pre-marked -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

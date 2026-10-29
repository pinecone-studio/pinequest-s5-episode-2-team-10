"""Labelled rows from seed_mn.txt, plus variants with fillers inserted at random gaps.

    python -m training.fillers.seed --out data/fillers/seed.jsonl --variants 8

In seed_mn.txt a filler is written in [brackets]; everything else, including тэгээд / нөгөө / за used
with their real meaning, is not a filler. Variants of a sentence stay in the same pitch, so a held-out
pitch never shares a sentence with training.
"""

import argparse
import random
import re
import sys
from pathlib import Path

from pipeline.tokens import tokens

from . import labels

SEED_FILE = Path(__file__).with_name("seed_mn.txt")
INSERTS = ["ээ", "ээ", "аан", "аан", "мм", "ээм", "хмм", "нөгөө", "яахав", "юу гэдэг юм", "за тэгээд", "тэгээд тэгээд"]
BRACKET = re.compile(r"\[([^\]]+)\]")


def parse_line(line: str) -> tuple[list[str], list[int]]:
    """Tokens of one seed sentence and the positions of its bracketed fillers."""
    words, marked = [], []
    pos = 0
    for m in BRACKET.finditer(line):
        words += tokens(line[pos : m.start()])
        filler = tokens(m.group(1))
        marked += range(len(words), len(words) + len(filler))
        words += filler
        pos = m.end()
    words += tokens(line[pos:])
    return words, marked


def read_seed(path: Path = SEED_FILE) -> list[list[tuple[list[str], list[int]]]]:
    """Pitches, each a list of (tokens, filler positions)."""
    pitches, current = [], []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("#"):
            continue
        if not line:
            if current:
                pitches.append(current)
            current = []
            continue
        current.append(parse_line(line))
    if current:
        pitches.append(current)
    return pitches


def variant(words: list[str], marked: list[int], rng: random.Random) -> tuple[list[str], list[int]]:
    """The sentence without its fillers, with 1–3 new fillers at random gaps."""
    keep = [w for i, w in enumerate(words) if i not in set(marked)]
    gaps = sorted(rng.sample(range(len(keep) + 1), k=min(len(keep) + 1, rng.randint(1, 3))))
    out, out_marked, start = [], [], 0
    for g in gaps:
        out += keep[start:g]
        filler = tokens(rng.choice(INSERTS))
        out_marked += range(len(out), len(out) + len(filler))
        out += filler
        start = g
    out += keep[start:]
    return out, out_marked


def build(variants: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    rows = []
    for p, pitch in enumerate(read_seed(), 1):
        name = f"seed-{p:02d}"
        sentences = list(pitch)
        for words, marked in pitch:
            sentences += [variant(words, marked, rng) for _ in range(variants)]
        for sid, (words, marked) in enumerate(sentences):
            rows.append({"pitch": name, "sentence_id": sid, "text": " ".join(words), "tokens": words,
                         "filler_idx": sorted(marked), "checked": False, "source": "seed" if sid < len(pitch) else "augment"})
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path("data/fillers/seed.jsonl"))
    ap.add_argument("--variants", type=int, default=8, help="random-filler variants per seed sentence")
    ap.add_argument("--seed", type=int, default=5)
    args = ap.parse_args()
    rows = build(args.variants, args.seed)
    labels.write(args.out, rows)
    print(f"{len({r['pitch'] for r in rows})} pitches, {len(rows)} sentences, "
          f"{sum(len(r['filler_idx']) for r in rows)} filler tokens -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

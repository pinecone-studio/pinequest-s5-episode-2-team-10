"""A token classifier for filler words (XLM-RoBERTa by default): train it and run it.

    # train (Kaggle T4 or the GPU PC); silver and/or hand labels, whole pitches held out for testing
    python -m training.fillers.classifier train --data data/fillers/silver.jsonl --data data/fillers/labels.jsonl \
        --out data/fillers/model
    # predict for evaluate.py (on the hand-checked rows)
    python -m training.fillers.classifier predict --model data/fillers/model --labels data/fillers/labels.jsonl \
        --out data/fillers/clf.jsonl
    python -m training.fillers.evaluate --predictions data/fillers/clf.jsonl --backend gemma4-base

Every word of a sentence gets "filler" or "not": the label sits on its first sub-word piece.
Needs `pip install torch transformers accelerate sentencepiece` (not part of the app's requirements).
"""

import argparse
import inspect
import json
import random
import sys
from pathlib import Path

from . import labels

BASE_MODEL = "FacebookAI/xlm-roberta-base"
MAX_LEN = 128  # sentences are split at 40 words, so this fits whole sentences


def encode(tokenizer, row: dict) -> dict:
    enc = tokenizer(row["tokens"], is_split_into_words=True, truncation=True, max_length=MAX_LEN)
    marked, seen, word_labels = set(row["filler_idx"]), set(), []
    for w in enc.word_ids():
        if w is None or w in seen:
            word_labels.append(-100)  # special tokens and later sub-word pieces don't count
        else:
            seen.add(w)
            word_labels.append(1 if w in marked else 0)
    enc["labels"] = word_labels
    return enc


def split_pitches(rows: list[dict], test_share: float, seed: int) -> tuple[list[dict], list[dict]]:
    """Whole pitches go to test, so no test sentence's neighbours were seen in training.

    Hand-checked rows are preferred for the test set; silver rows only fill it if there are none.
    """
    pitches = labels.by_pitch(rows)
    checked = [p for p, rs in pitches.items() if all(r.get("checked") for r in rs)]
    pool = checked or list(pitches)
    random.Random(seed).shuffle(pool)
    test = set(pool[: max(1, round(len(pitches) * test_share))]) if len(pitches) > 1 else set()
    return ([r for r in rows if r["pitch"] not in test], [r for r in rows if r["pitch"] in test])


def predict_rows(model_dir: Path, rows: list[dict], batch: int = 32) -> dict[tuple[str, int], set[int]]:
    import torch
    from transformers import AutoModelForTokenClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(model_dir)
    model = AutoModelForTokenClassification.from_pretrained(model_dir).eval()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    out = {}
    for i in range(0, len(rows), batch):
        part = rows[i : i + batch]
        enc = tokenizer([r["tokens"] for r in part], is_split_into_words=True, truncation=True,
                        max_length=MAX_LEN, padding=True, return_tensors="pt")
        with torch.no_grad():
            pred = model(**{k: v.to(device) for k, v in enc.items()}).logits.argmax(-1).tolist()
        for b, row in enumerate(part):
            seen, marked = set(), set()
            for pos, w in enumerate(enc.word_ids(b)):
                if w is not None and w not in seen:
                    seen.add(w)
                    if pred[b][pos] == 1:
                        marked.add(w)
            out[(row["pitch"], row["sentence_id"])] = marked
    return out


def train(args) -> int:
    import numpy as np
    import torch
    from transformers import (AutoModelForTokenClassification, AutoTokenizer, DataCollatorForTokenClassification,
                              Trainer, TrainingArguments)

    rows = [r for path in args.data for r in labels.read(path)]
    # A pitch in both silver and hand labels: keep the hand-checked version.
    by_key = {}
    for r in rows:
        key = (r["pitch"], r["sentence_id"])
        if key not in by_key or r.get("checked"):
            by_key[key] = r
    rows = list(by_key.values())
    train_rows, test_rows = split_pitches(rows, args.test_share, args.seed)
    print(f"{len(train_rows)} training sentences, {len(test_rows)} test sentences "
          f"({sum(r.get('checked', False) for r in test_rows)} hand-checked)")

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForTokenClassification.from_pretrained(
        args.base, num_labels=2, id2label={0: "not", 1: "filler"}, label2id={"not": 0, "filler": 1})
    train_set = [encode(tokenizer, r) for r in train_rows]

    # Fillers are a few percent of words: weight them up so the model doesn't learn "never a filler".
    counts = np.bincount([l for e in train_set for l in e["labels"] if l != -100], minlength=2)
    weight = torch.tensor([1.0, min(20.0, float(counts[0]) / max(1, int(counts[1])))], dtype=torch.float32)
    print(f"words: {counts[0]} not, {counts[1]} filler -> filler weight {weight[1]:.1f}")

    class Weighted(Trainer):
        def compute_loss(self, model, inputs, return_outputs=False, **kwargs):
            gold = inputs.pop("labels")
            outputs = model(**inputs)
            loss = torch.nn.functional.cross_entropy(
                outputs.logits.view(-1, 2), gold.view(-1), weight=weight.to(outputs.logits.device), ignore_index=-100)
            return (loss, outputs) if return_outputs else loss

    # transformers 5 takes the warmup ratio as a float warmup_steps; 4.x (Kaggle images) has warmup_ratio.
    warmup = ({"warmup_ratio": 0.1} if "warmup_ratio" in inspect.signature(TrainingArguments).parameters
              else {"warmup_steps": 0.1})
    trainer = Weighted(
        model=model,
        args=TrainingArguments(output_dir=str(args.out / "checkpoints"), num_train_epochs=args.epochs,
                               learning_rate=args.lr, per_device_train_batch_size=16, weight_decay=0.01,
                               logging_steps=50, save_strategy="no", report_to=[], seed=args.seed,
                               fp16=torch.cuda.is_available(), **warmup),
        train_dataset=train_set,
        data_collator=DataCollatorForTokenClassification(tokenizer),
    )
    trainer.train()
    trainer.save_model(str(args.out))
    tokenizer.save_pretrained(str(args.out))

    if test_rows:
        result = labels.score(test_rows, predict_rows(args.out, test_rows))
        result.pop("per_word")
        print("held-out pitches:", json.dumps({k: round(v, 3) if isinstance(v, float) else v for k, v in result.items()}))
        (args.out / "test_score.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        labels.write(args.out / "test_rows.jsonl", test_rows)
    print(f"model -> {args.out}")
    return 0


def predict(args) -> int:
    rows = labels.read(args.labels)
    predicted = predict_rows(args.model, rows)
    with args.out.open("w", encoding="utf-8") as f:
        for row in rows:
            for i in sorted(predicted[(row["pitch"], row["sentence_id"])]):
                f.write(json.dumps({"pitch": row["pitch"], "sentence_id": row["sentence_id"],
                                    "word": row["tokens"][i], "token_idx": i}, ensure_ascii=False) + "\n")
    print(f"{sum(len(v) for v in predicted.values())} fillers in {len(rows)} sentences -> {args.out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--data", type=Path, action="append", required=True, help="labels JSONL, repeatable")
    t.add_argument("--out", type=Path, default=Path("data/fillers/model"))
    t.add_argument("--base", default=BASE_MODEL)
    t.add_argument("--epochs", type=float, default=4)
    t.add_argument("--lr", type=float, default=3e-5)
    t.add_argument("--test-share", type=float, default=0.15)
    t.add_argument("--seed", type=int, default=7)
    p = sub.add_parser("predict")
    p.add_argument("--model", type=Path, default=Path("data/fillers/model"))
    p.add_argument("--labels", type=Path, default=Path("data/fillers/labels.jsonl"))
    p.add_argument("--out", type=Path, default=Path("data/fillers/clf.jsonl"))
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)
    return train(args) if args.cmd == "train" else predict(args)


if __name__ == "__main__":
    sys.exit(main())

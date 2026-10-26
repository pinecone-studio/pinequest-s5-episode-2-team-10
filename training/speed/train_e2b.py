"""Fine-tune Gemma 4 E2B to answer like E4B (QLoRA with Unsloth), then export a GGUF for Ollama.

Run on a GPU (Kaggle T4/P100 or the RTX 4060), after make_data.py:
    pip install unsloth trl datasets
    python -m training.speed.train_e2b --data data/speed --out data/speed/model

Stop Ollama first if it runs on the same GPU (the teacher would take the memory).
Writes <out>/gguf/*.gguf (Q4_K_M) and <out>/Modelfile; see README.md for `ollama create`.
"""

import argparse
import json
from pathlib import Path

PLACEHOLDER = "XQZ_PLACEHOLDER_XQZ"


def turn_markers(tokenizer) -> tuple[str, str]:
    """The text that starts a user turn and a model turn in this model's chat template.

    Found by rendering a tiny conversation, so it works whatever the template looks like.
    """
    rendered = tokenizer.apply_chat_template(
        [{"role": "user", "content": PLACEHOLDER}, {"role": "assistant", "content": PLACEHOLDER}], tokenize=False
    )
    first = rendered.index(PLACEHOLDER)
    second = rendered.index(PLACEHOLDER, first + len(PLACEHOLDER))
    between = rendered[first + len(PLACEHOLDER) : second]
    before_user = rendered[:first]
    # The last line(s) before each placeholder are the turn headers.
    user_part = before_user[before_user.rfind("\n", 0, len(before_user) - 1) + 1 :] or before_user
    model_part = between[between.rfind("\n", 0, len(between) - 1) + 1 :] or between
    bos = getattr(tokenizer, "bos_token", None)
    if bos and user_part.startswith(bos):
        user_part = user_part[len(bos) :]  # the start-of-text token isn't part of the turn header
    return user_part, model_part


def find_train_file(data: Path) -> Path:
    """train.jsonl in `data`, or anywhere below it (Kaggle mounts datasets in nested folders)."""
    if (data / "train.jsonl").is_file():
        return data / "train.jsonl"
    for root in (data, data.parent):
        found = sorted(root.rglob("train.jsonl")) if root.is_dir() else []
        if found:
            return found[0]
    raise SystemExit(f"train.jsonl not found in {data} or below it; pass the right folder with --data")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=Path("data/speed"))
    ap.add_argument("--out", type=Path, default=Path("data/speed/model"))
    ap.add_argument("--base", default="unsloth/gemma-4-E2B-it")
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--max-seq", type=int, default=8192)
    args = ap.parse_args()

    # Unsloth first: it patches trl/transformers when imported.
    from unsloth import FastModel
    from unsloth.chat_templates import train_on_responses_only
    from datasets import Dataset
    from trl import SFTConfig, SFTTrainer

    train_file = find_train_file(args.data)
    print(f"training data: {train_file}")

    model, tokenizer = FastModel.from_pretrained(args.base, max_seq_length=args.max_seq, load_in_4bit=True)
    model = FastModel.get_peft_model(
        model, r=args.rank, lora_alpha=args.rank, lora_dropout=0, bias="none",
        finetune_vision_layers=False, finetune_language_layers=True,
        finetune_attention_modules=True, finetune_mlp_modules=True, random_state=7,
    )

    rows = [json.loads(line) for line in train_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    texts = [tokenizer.apply_chat_template(r["messages"], tokenize=False) for r in rows]
    print(f"{len(texts)} training examples")

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=Dataset.from_dict({"text": texts}),
        args=SFTConfig(
            dataset_text_field="text", max_seq_length=args.max_seq, per_device_train_batch_size=1,
            gradient_accumulation_steps=8, num_train_epochs=args.epochs, learning_rate=2e-4, warmup_steps=5,
            logging_steps=5, optim="adamw_8bit", weight_decay=0.01, lr_scheduler_type="linear", seed=7,
            output_dir=str(args.out / "checkpoints"), report_to="none",
        ),
    )
    # Learn only the answers, not the (long) prompts.
    user_part, model_part = turn_markers(tokenizer)
    print(f"turn markers: user={user_part!r} model={model_part!r}")
    trainer = train_on_responses_only(trainer, instruction_part=user_part, response_part=model_part)
    trainer.train()

    args.out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained_gguf(str(args.out / "gguf"), tokenizer, quantization_method="q4_k_m")
    gguf = sorted((args.out / "gguf").glob("*.gguf"))
    (args.out / "Modelfile").write_text(
        f"FROM ./gguf/{gguf[-1].name if gguf else 'model.gguf'}\n"
        "# Copy TEMPLATE and PARAMETER lines from: ollama show gemma4:e2b --modelfile\n"
        "PARAMETER temperature 0\n",
        encoding="utf-8",
    )
    print(f"GGUF written to {args.out / 'gguf'}; Modelfile at {args.out / 'Modelfile'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

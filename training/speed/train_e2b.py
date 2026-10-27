"""Fine-tune Gemma 4 E2B to answer like E4B (QLoRA with Unsloth), then export a GGUF for Ollama.

Run on a GPU (Kaggle T4/P100 or the RTX 4060), after make_data.py:
    pip install unsloth trl datasets
    python -m training.speed.train_e2b --data data/speed --out data/speed/model

Stop Ollama first if it runs on the same GPU (the teacher would take the memory).

Writes, in this order, so a later failure never loses an earlier step:
    <out>/lora/            the trained adapter (small; saved as soon as training ends)
    <out>/gguf/*.gguf      the Q4_K_M model for Ollama (about 3 GB)
    <out>/Modelfile        points Ollama at that file; see README.md for `ollama create`

If the GGUF export fails, rerun only the export from the saved adapter:
    python -m training.speed.train_e2b --out <out> --export-only
"""

import argparse
import json
import sys
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


def pick_gguf(files: list[Path]) -> Path | None:
    """The quantized model among the export's files: Q4_K_M, not the image projector or an F16 copy."""
    models = [f for f in files if "mmproj" not in f.name.lower()]
    for f in sorted(models):
        if "q4_k_m" in f.name.lower():
            return f
    return sorted(models, key=lambda f: f.stat().st_size)[0] if models else None


def export_gguf(model, tokenizer, out: Path) -> int:
    """Q4_K_M GGUF plus a Modelfile. Some Unsloth versions write to `<dir>_gguf`, so search for it."""
    model.save_pretrained_gguf(str(out / "gguf"), tokenizer, quantization_method="q4_k_m")
    found = sorted(out.rglob("*.gguf"))
    print("GGUF files:", *(f"  {f} ({f.stat().st_size / 1e9:.2f} GB)" for f in found), sep="\n")
    gguf = pick_gguf(found)
    if gguf is None:
        print(f"No .gguf file was written under {out}.", file=sys.stderr)
        return 1
    (out / "Modelfile").write_text(
        f"FROM ./{gguf.relative_to(out).as_posix()}\n"
        "# Copy TEMPLATE and PARAMETER lines from: ollama show gemma4:e2b --modelfile\n"
        "PARAMETER temperature 0\n",
        encoding="utf-8",
    )
    print(f"Model: {gguf}\nModelfile: {out / 'Modelfile'}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=Path("data/speed"))
    ap.add_argument("--out", type=Path, default=Path("data/speed/model"))
    ap.add_argument("--base", default="unsloth/gemma-4-E2B-it")
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--max-seq", type=int, default=8192)
    ap.add_argument("--export-only", action="store_true", help="skip training; export the GGUF from <out>/lora")
    args = ap.parse_args()

    from datasets import Dataset
    from trl import SFTConfig, SFTTrainer
    from unsloth import FastModel
    from unsloth.chat_templates import train_on_responses_only

    args.out.mkdir(parents=True, exist_ok=True)
    lora = args.out / "lora"
    print(f"Output folder: {args.out.resolve()}")
    if args.export_only:
        if not (lora / "adapter_config.json").exists():
            print(f"No saved adapter at {lora}; train first.", file=sys.stderr)
            return 1
        model, tokenizer = FastModel.from_pretrained(str(lora), max_seq_length=args.max_seq, load_in_4bit=True)
        return export_gguf(model, tokenizer, args.out)

    model, tokenizer = FastModel.from_pretrained(args.base, max_seq_length=args.max_seq, load_in_4bit=True)
    model = FastModel.get_peft_model(
        model, r=args.rank, lora_alpha=args.rank, lora_dropout=0, bias="none",
        finetune_vision_layers=False, finetune_language_layers=True,
        finetune_attention_modules=True, finetune_mlp_modules=True, random_state=7,
    )

    rows = [json.loads(line) for line in (args.data / "train.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
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

    # Save the training before the export, which is the step most likely to fail.
    model.save_pretrained(str(lora))
    tokenizer.save_pretrained(str(lora))
    print(f"Adapter saved: {lora}")
    try:
        return export_gguf(model, tokenizer, args.out)
    except Exception as e:  # keep the adapter; say how to retry
        print(f"GGUF export failed: {e}\nThe training is saved in {lora}. Retry the export with:\n"
              f"  python -m training.speed.train_e2b --out {args.out} --export-only", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

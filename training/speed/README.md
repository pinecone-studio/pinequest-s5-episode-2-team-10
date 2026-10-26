# A faster feedback model: Gemma 4 E2B trained to answer like E4B

**Why:** on the 8 GB RTX 4060, BuzzASR (~3 GB) and Gemma 4 E4B (~6.6 GB plus working memory) don't fit together, so part of Gemma runs on the CPU and answers take 10–25 s or more. Gemma 4 E2B is about half the size, so it fits on the GPU next to BuzzASR and generates faster. On its own E2B is weaker, so it's fine-tuned on E4B's checked answers to the app's own prompt (distillation). The answers are stored as compact JSON, so the model also learns to write fewer tokens.

Nothing here has been run on a GPU yet: expect to adjust settings on the first run, and trust only the numbers from `benchmark.py`.

## Steps (Kaggle GPU notebook or the GPU PC)

```bash
# 0. The repo code, plus Ollama with the teacher model
curl -fsSL https://ollama.com/install.sh | sh && (ollama serve &) && ollama pull gemma4:e4b
pip install -r requirements.txt httpx

# 1. Training data: real transcripts (one .txt per pitch, with consent) and/or synthetic pitches
python -m training.speed.make_data --transcripts data/transcripts --synthetic 300 --out data/speed

# 2. Fine-tune E2B (stop Ollama first so the GPU is free)
pkill ollama
pip install unsloth trl datasets
python -m training.speed.train_e2b --data data/speed --out data/speed/model

# 3. Load it into Ollama: copy TEMPLATE/PARAMETER lines from `ollama show gemma4:e2b --modelfile`
#    into data/speed/model/Modelfile, then
(ollama serve &) && ollama pull gemma4:e2b
ollama create pitchcoach-e2b -f data/speed/model/Modelfile

# 4. Compare on held-out pitches (run this on the 4060 for real speed numbers)
python -m training.speed.benchmark --models gemma4:e4b gemma4:e2b pitchcoach-e2b --data data/speed
```

## Using it in the app

Copy the GGUF to the GPU PC, run `ollama create pitchcoach-e2b -f Modelfile` there, and set `PITCH_OLLAMA_MODEL_BASE=pitchcoach-e2b` (web app and backend). Keep E4B as the fallback until the benchmark shows the E2B answers are close enough.

## What "good enough" means

- **Speed:** median seconds per answer clearly below E4B's on the 4060, with BuzzASR loaded.
- **Valid answers:** the same share passing the schema as E4B (Ollama enforces the format, so this should be near 100%).
- **Agreement with E4B:** content scores within a few points on average, and filler words mostly the same (F1 close to 1).

Synthetic pitches teach the format and the judging style; real recordings teach real speech. Mix both, keep the test set fixed, and don't trust a model trained only on synthetic data without checking real pitches.

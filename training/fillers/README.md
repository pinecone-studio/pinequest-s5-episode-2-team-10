# Filler words: hand labels and a baseline before any fine-tuning

**Why:** the app finds fillers in two steps (`pipeline/fillers.py`): the word list `fillers_mn.txt` marks candidates, then the feedback model decides in context ("тэгээд" as padding or as "and then"). Before training anything for this, measure how well that already works and where it fails. AI_PIPELINE.md asks for a baseline and enough permissioned examples first.

## Steps

```bash
# 1. A labelling sheet from real transcripts (one .txt per pitch, with consent; data/ is git-ignored)
python -m training.fillers.sheet --transcripts data/transcripts --out data/fillers/labels.jsonl

# 2. Label: open training/fillers/label.html in a browser, load the sheet, click words to mark or
#    unmark fillers, tick "шалгасан" per sentence, save back to data/fillers/labels.jsonl.

# 3. Baseline: the list alone, then the app's models on the same sentences
python -m training.fillers.evaluate --labels data/fillers/labels.jsonl
python -m training.fillers.evaluate --labels data/fillers/labels.jsonl --backend gemma4-base --backend claude \
    --out data/fillers/baseline.json
```

`evaluate` scores per token: a missed "ээ" is one false negative, a flagged "тэгээд" that meant "and then" is one false positive. It prints precision, recall and F1 per method, and the words with the most errors. Any other method (e.g. a trained classifier) can be compared by writing JSONL rows `{"pitch", "sentence_id", "word"}` and passing `--predictions`.

## Labelling rules

- Mark a word when removing it keeps the meaning: hesitations (ээ, аан, мм), padding (нөгөө, яахав), repeated "тэгээд тэгээд".
- Don't mark "тэгээд" that means "and then", "тийм" that answers something, or "за" that starts a reply.
- Mark every token of a multi-word filler ("юу гэдэг юм" is three marks).
- Two people labelling the same 5 pitches and comparing (`evaluate --predictions` works for this too) shows how clear the rules are.

## What the numbers decide

| Result | Next step |
|---|---|
| Model F1 is high, but recall is low on ээ/аан | The transcript is missing them: speech recognition drops hesitations. Fix or measure ASR, not the text model. |
| List recall is high, precision low (тэгээд, нөгөө) | The context check is the weak part: train a small token classifier on these labels, or add the labels to the E2B distillation (`training/speed`). |
| The model misses fillers not in the list | Add them to `fillers_mn.txt` first; it is the cheapest fix. |

About 1,000–3,000 checked sentences are enough to train a small classifier; keep a fixed test set of whole pitches that never goes into training.

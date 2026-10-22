# Saylo Testing and Evaluation

## 0. Running the checks

```bash
python -m pytest tests                      # Python: filler detection, verification, scoring
cd web && npm run lint && npx tsc --noEmit && npm run build
```

For a full run without a GPU, start the API with `PITCH_ASR=stub PITCH_EMBEDDINGS=none` and analyze with the `rules` model; reports then say which parts used sample data.

## Trying the AI analysis on its own

The LLM step can be tested before the speech-to-text, slides, and UI work is finished. `scripts/try_analysis.py` takes a plain-text transcript (and optionally slides and a script), runs the same analysis code as the server, and prints what the model decided: filler words kept, dropped, and added compared with the word list, content scores, and recommendations.

```bash
python -m scripts.try_analysis                                  # sample transcript, no model
python -m scripts.try_analysis --backend ollama:qwen3:8b        # any model in your local Ollama
python -m scripts.try_analysis --backend claude                 # needs ANTHROPIC_API_KEY
python -m scripts.try_analysis --text my_pitch.txt --slides deck.pdf --script plan.txt --runs 3 --json out.json
```

Which model to use:
- **No model (`rules`)**: free and instant; checks the plumbing and the word list only.
- **Local Ollama (`ollama:<model>`, `gemma4-base`, `gemma4-ft`)**: free, runs on your machine. Install Ollama and pull a model (`ollama pull gemma4:e4b`). Use the RTX 4060 machine: an 8B model needs about 6.7 GB with the analysis prompt, so on an 8 GB laptop it swaps to disk and a run can take tens of minutes. Set `PITCH_OLLAMA_TIMEOUT_S` higher if it times out.
- **Claude (`claude`)**: no local model needed, fastest and the strongest baseline, but each run costs money on the team's Anthropic key.

`scripts/samples/pitch_fillers.txt` is a transcript with known answers (listed in `scripts/samples/README.md`): which words are fillers, which look like fillers but carry meaning, and which fillers are missing from the word list. `--runs 3` repeats the analysis to show how consistent the model is.

## 1. Speech-to-text evaluation

Build a small, permissioned Mongolian audio set with human-corrected reference transcripts. Include multiple speakers, topics, recording devices, background-noise levels, and speaking speeds.

Measure:
- Word Error Rate (WER)
- Important meaning-changing errors
- Names, numbers, and domain-specific terms
- Whether errors systematically affect certain recording conditions

WER alone is not enough. Mongolian tokenization and morphology can influence the score, so include manual review.

## 2. AI feedback evaluation

Have reviewers rate each analysis for:
- Evidence accuracy: are quoted excerpts present in the transcript?
- Issue correctness: is the identified problem genuinely supported?
- Rewrite fidelity: does the rewrite preserve the intended meaning?
- Usefulness: can the user act on the recommendation?
- Tone: is the feedback constructive and respectful?
- Language quality: is the response natural in the transcript language?

## 3. Functional test cases

- Supported audio uploads successfully.
- Unsupported format is rejected.
- Oversized or excessively long audio is rejected.
- Transcription provider timeout produces a recoverable failure.
- Empty or unusable transcript does not receive a misleading score.
- Malformed LLM output is rejected or retried safely.
- Evidence snippets are checked against transcript text.
- A user cannot access another user's recording.
- Deleting a recording removes its associated data and audio according to policy.
- Refreshing the page does not lose the persisted processing status.

## 4. Performance and cost

Track:
- Upload success rate
- Transcription success rate
- Analysis success rate
- Median and P95 processing time
- Provider failures and retry count
- Average cost per recording

## 5. Demo acceptance checklist

- [ ] A complete happy path works from upload to results.
- [ ] At least several Mongolian recordings have been manually reviewed.
- [ ] Scores are described as coaching estimates.
- [ ] Failure states are tested.
- [ ] API keys are not present in client code or committed files.
- [ ] Audio storage access is private.
- [ ] The demo does not overclaim voice-analysis capabilities.

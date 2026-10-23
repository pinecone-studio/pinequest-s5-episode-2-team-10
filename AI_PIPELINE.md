# Saylo AI Pipeline

## Goal

Turn a user's recording into a useful transcript-based speaking practice report with evidence and concrete next steps.

## Pipeline (as built)

The worker runs these steps for each attempt (`pipeline/run.py`):

1. **Audio validation and conversion** (`backend/main.py`, `pipeline/audio.py`)
   - Checks extension, size (25 MB), duration (3 s to 5 min), and that ffmpeg can decode the file.
   - Converts to 16 kHz mono WAV; the original upload is kept for playback.

2. **Speech-to-text** (`pipeline/asr.py`)
   - BuzzASR/mongolian (Whisper large-v3) through transformers, with word timestamps. Runs on the GPU machine and is unloaded before the LLM runs.
   - `PITCH_ASR=stub` returns sample text for testing; the report says so in `notes`.
   - Mongolian ASR quality still has to be measured (see the evaluation plan below).

3. **Transcript segmentation and checks** (`segments.py`, `text_checks.py`, `fillers.py`, `metrics.py`)
   - Sentences split at punctuation or pauses over 0.7 s, with start and end times. The speaker's words are not rewritten.
   - Word-list filler candidates, repeated words, sentence lengths; pace, long pauses, pitch range, volume drop.

4. **Slides** (`slides.py`, `alignment.py`), when a deck is uploaded
   - Text, numbers, and key terms per slide; speech matched to slides by content (no slide timing is known); numbers on slides not heard nearby become candidates for the model to check.

5. **LLM analysis** (`feedback.py`, prompt in `prompts/feedback_v2.md`)
   - One call to the chosen model: Claude (Anthropic API) or Gemma 4 through Ollama (fine-tuned or base). All get the same prompt and JSON schema.
   - The model scores content criteria with exact transcript quotes as evidence, confirms filler words in context, checks slide numbers, and writes up to 5 recommendations with an example sentence. If a planned script is given, it flags important points that were skipped or changed.

6. **Output validation** (`feedback.py`)
   - The JSON schema is enforced by the provider and checked again with Pydantic; failures become a readable error.
   - Code then checks the content: timestamps must match a transcript sentence, slide numbers must exist, filler occurrences must be in the named sentence, and number checks must match the candidates. Anything else is dropped.

7. **Scoring** (`scoring.py`)
   - Overall = 0.35 Content + 0.30 Delivery + 0.25 Slide alignment + 0.10 Timing, computed in code; a category without data is null and the rest are reweighted.
   - All thresholds live in one table. Scores are coaching estimates until validated by human review.

8. **Display** (`web/`)
   - Score and categories, filler words with examples and timestamps, recommendations, delivery metrics, content criteria, slide coverage, the transcript with fillers highlighted, and the uploaded files. Notes about stub data or missing models are shown.

## Output contract

The schema is defined in code: `Feedback` in `pipeline/feedback.py`. The full report the web app receives is in `API.md`.

Not built yet from the PRD's suggested contract:
- an improved transcript that preserves the speaker's meaning
- practice tasks (title, instruction, goal)
- separate clarity, conciseness, and repetition categories (repetition is measured in `wording.repeats` but not scored)
- a limited-result state for transcripts that are too short or unreliable (today only very short audio is rejected)

## Trying the analysis without the rest of the app

`python -m scripts.try_analysis` runs only the LLM analysis on a plain-text transcript, with Claude, any local Ollama model, or no model. See `TESTING.md`.

## Analysis instructions

- Use the language of the recording where possible.
- Do not fabricate evidence, filler words, or transcript content.
- Treat ASR mistakes as possible transcription errors, not automatically as speaker mistakes.
- Avoid judging accent, identity, personality, or intelligence.
- Keep feedback concise, specific, and constructive.
- When the transcript is too short or unreliable, return a limited-result state instead of a confident score.

## Mongolian evaluation plan

Create a consented test set that includes different speakers, recording environments, speaking speeds, and presentation topics. Have humans correct reference transcripts. Compare ASR output with the reference using Word Error Rate (WER), while also reviewing meaningful errors manually because tokenization and Mongolian morphology can affect WER interpretation.

For feedback, ask human reviewers to rate correctness, evidence alignment, usefulness, and whether the rewrite preserves meaning. Do not fine-tune a model until the team has enough permissioned examples and a clear evaluation baseline.

## Implemented: filler words

Built in the FastAPI pipeline (`pipeline/fillers.py`, `pipeline/feedback.py`):

1. **Word list candidates.** Code marks every occurrence of a word or phrase from `pipeline/fillers_mn.txt` (whole words, longest phrase first), per transcript sentence.
2. **Context check by the LLM.** The candidates go to the analysis model with the transcript. It returns `filler_occurrences` (`sentence_id`, `word`), keeping only words used as fillers ("тэгээд" as padding, not as "and then") and adding fillers the list missed.
3. **Verification in code.** An occurrence is kept only if its word is in that sentence, and never more times than it appears there. Invented sentences, words or counts are dropped.
4. **Counting and scoring in code.** The report's `feedback.fillers` has `total`, `per_100`, and per word the `count`, evidence sentences and timestamps. The Delivery score uses this verified rate (full score under 1 per 100 words, zero at 6). The raw list counts are kept in `wording.list_fillers` for evaluation.
5. **Limits are shown.** With no model (`rules` backend), `method` is `"list"` and the UI says the words were not checked in context. When nothing is found, the report notes that speech recognition can drop hesitation sounds.

The prompt version is stored with each report (`prompt_version`). Tests: `tests/test_fillers.py`.

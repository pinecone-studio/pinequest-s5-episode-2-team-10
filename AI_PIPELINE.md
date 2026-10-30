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
   - The model scores content criteria with exact transcript quotes as evidence, confirms filler words in context, checks slide numbers, and writes up to 5 recommendations with an example sentence. If a planned script is given, it flags important points that were skipped or changed. If the project has a pitch idea and main points, it marks each point covered, partial or missed with a quote, and flags off-topic sentences.

6. **Output validation** (`feedback.py`)
   - The JSON schema is enforced by the provider and checked again with Pydantic; failures become a readable error.
   - Code then checks the content: timestamps must match a transcript sentence, slide numbers must exist, filler occurrences must be in the named sentence, main-point quotes must be in the transcript, and number checks must match the candidates. Anything else is dropped.

6a. **Fallbacks when the GPU PC can't be used** (`asr.transcribe_with_fallback`, `feedback.generate_with_fallback`)
   - If the voice server is down, unreachable, too slow or refuses the token, Duudlaga transcribes instead (`PITCH_ASR_FALLBACK`, needs `DUUDLAGA_API_KEY`). Its text is placed over the parts of the audio with sound, like the voice server's, so pauses and the delivery checks still work.
   - If Gemma (Ollama) can't be reached or lacks the model, Claude writes the feedback when `ANTHROPIC_API_KEY` is set, otherwise the no-model check (`PITCH_FEEDBACK_FALLBACK`). A reply that isn't JSON (empty, or text around it that can't be read) is asked for once more; if the second one isn't JSON either, the fallback writes the feedback. The warning in the backend log gives the Ollama host, `done_reason`, token counts and the reply's length, never its text. An answer that is JSON but doesn't match the schema does not fall back. Tests: `tests/test_gemma_reply.py`.
   - The report's `backend` is the model actually used, and `fallbacks` lists what stood in; the pitch page says so above the result. Tests: `tests/test_fallbacks.py`.

6b. **Delivery checks** (`delivery.py`, `loudness.py`), by code after the model's advice
   - Added to `recommendations` as `area: "delivery"` items with `source: "measured"`, after the model's (up to 5), each with `start_s` at the moment it happened so the page shows the sentence said there. Messages are in Mongolian, like the rest of the backend's feedback.
   - Rushed 30 s stretch (30% and 25 words/min above the speaker's usual pace); speeding up in the last quarter (25% faster, pitches of 40 s or more); silences of 3 s or more; 4+ fillers within 20 s (the fillers confirmed in context); sentences whose last two words are both 6 dB quieter than the rest (in at least 2 sentences and a quarter of them).
   - Word times are estimates (pauses are real silences; times inside speech are spread evenly), so pace is never judged per word. Loudness per word is read from the recording (90th percentile of its frames, so silence next to a short last word doesn't count) and only compared within one recording. Mongolian sentence endings are naturally softer, so one quiet last word isn't a fade. The limits are first guesses; tune them on real recordings.
   - The numbers behind them are stored in the report's `extra.delivery_checks` (not in the API). A failure here is logged and skipped; it never fails the analysis. Tests: `tests/test_delivery.py`, `tests/test_loudness.py`.

7. **Scoring** (`scoring.py`)
   - Overall = 0.35 Content + 0.30 Delivery + 0.25 Slide alignment + 0.10 Timing, computed in code; a category without data is null and the rest are reweighted.
   - All thresholds live in one table. Scores are coaching estimates until validated by human review.

8. **Display** (`web/`)
   - Score and categories, filler words with examples and timestamps, recommendations, delivery metrics, content criteria, slide coverage, the transcript with fillers highlighted, and the uploaded files. Notes about stub data or missing models are shown.

## Output contract

The schema is defined in code: `Feedback` in `pipeline/feedback.py`. The full report the web app receives is in `API.md`.

Not built yet from the PRD's suggested contract:
- an improved transcript that preserves the speaker's meaning
- separate clarity, conciseness, and repetition categories (repetition is measured in `wording.repeats` but not scored)
- a limited-result state for transcripts that are too short or unreliable (today only very short audio is rejected)

Feedback now includes two or three `practice_tasks` (`title`, `instruction`, `goal`). LLM tasks are requested in the versioned prompt and validated by Pydantic; the rules backend turns measured recommendations into exercises and adds neutral practice drills when fewer than two recommendations are available.

## Trying the analysis without the rest of the app

`python -m scripts.try_analysis` runs only the LLM analysis on a plain-text transcript, with Claude, any local Ollama model, or no model. See `TESTING.md`.

## Analysis instructions

- Use the language of the recording where possible.
- Do not fabricate evidence, filler words, or transcript content.
- Treat ASR mistakes as possible transcription errors, not automatically as speaker mistakes.
- Avoid judging accent, identity, personality, or intelligence.
- Keep feedback concise, specific, and constructive.
- When the transcript is too short or unreliable, return a limited-result state instead of a confident score.

**Short answers.** Writing the answer is what makes analysis slow on the GPU PC, so the model only writes what needs judgement (prompt `v2.4`):
- at most 3 recommendations with short fields
- two practice tasks
- comments for at most 3 slides
- only the slide figures the speaker actually mentioned

Code fills in the rest. Every slide gets its alignment status, and every unmentioned figure is added as never said, so the report keeps one entry per slide and per figure. On a 23-slide Mongolian pitch this cut the answer from about 5,600 to 3,100 tokens (about 65 s to 35 s of writing on the RTX 4060).

**Earlier takes.** The worker passes `previous_takes` with each analysis: up to the 2 newest finished takes of the same project, each with its top 3 fixes, main-point statuses, pace and fillers. A re-analysis of the same recording (same file name and length) doesn't count.
- **Summary:** the model opens it by comparing with the newest earlier take.
- **Still-open fixes:** code (`mark_still_open`) starts a fix that the newest earlier take was also given with "Өмнөх бичлэгээс хойш хэвээр:", matching by shared word stems.

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

6. **Optional fine-tuned classifier.** `PITCH_FILLER_MODEL` turns on the token classifier trained in `training/fillers` (`pipeline/filler_model.py`). Set it to a model folder to run it in the API process, or to `remote` to call the voice server's `/v1/fillers` (the voice PC sets `FILLER_MODEL_PATH`; Render has too little RAM). When on, its marks replace the LLM's `filler_occurrences` and `method` is `"model"`; they still pass step 3. If it is off or fails, the LLM's (or the list's) fillers stand. It has only been measured on synthetic sentences, so keep it off in production until `training/fillers/evaluate.py` shows it matching the LLM on hand-labelled real transcripts.

The prompt version is stored with each report (`prompt_version`). Tests: `tests/test_fillers.py`, `tests/test_filler_model.py`.

## Implemented: main points

Does the speech make the points the speaker meant to make? Built in `pipeline/points.py` and `pipeline/feedback.py`:

1. **Input.** A project has an optional `idea` and up to 6 `key_points`. They are copied to the attempt and sent to the model as `pitch`.
2. **Judgement by the LLM.** For each point the model returns `point_checks`: `covered`, `partial` or `missed`, an exact `evidence` quote and a short `note`. It also lists `off_topic` sentences and writes an `idea_comment`.
3. **Verification in code.** One result per point (a skipped point counts as missed). A covered or partial point whose quote is not in the transcript is marked `verified: false` and scored as missed. Off-topic sentences must exist, and their text is quoted by code, not by the model. Small models flag too much as off topic, so a flag is dropped when the sentence shares a key word with the idea or a main point, and a reason that only repeats the sentence is removed.
4. **Coverage in code.** covered = 1, partial = 0.5, missed = 0, averaged over the points, as `main_points.coverage` (0–100). It is reported on its own and does not change the overall score yet.
5. **Without a model** (`rules`), points are matched to sentences by key words (first 5 letters, so suffixes still match), with `method: "words"`; the report says it is a rough estimate.

Missed or partial points are usually turned into recommendations (area `content`); the `rules` backend adds up to two.

The folder page's "send to model" route (`web/src/lib/server/points.ts`) applies the same rules to the saved speech; keep the two in step. Tests: `tests/test_points.py`.

## Folder page: things to improve

The folder page's "send to model" (`web/src/app/api/prototype/route.ts`) judges the speech, not the slides; slide text is only used to check that the speech agrees with it.

The reply has a `summary`, up to 3 `strengths` and a list of `improvements`:

1. **Measured by code** (`web/src/lib/server/measure.ts`), the same for every model and shown first, marked "measured": filler words from `pipeline/fillers_mn.txt` with counts and rate per 100 words, back-to-back repeats, sentences over 25 words, run-on sentences with three or more «тэгээд», and numbers that disagree with the slides. A number said that isn't on the slides is paired with an unspoken slide figure of the same kind (decimal or whole, size, unit: time, size, percent or money), e.g. "the slides show 0.96, you said 0.86". The model is told these are already covered.
2. **Numbers said in words** ("гурван секунд") are left to the model: it gets the slide figures the speech doesn't contain as written and says what the speaker said instead. Code keeps a mismatch only when that quote is in the speech.
3. **The model's advice**: 2–4 items on the opening, the problem, the solution, proof, the ask at the end, and off-topic parts, each with `why`, `action`, an `example` sentence (no new facts or numbers) and a `sentence`: the number of the speech sentence where it shows (-1 for none). Code turns the number into the quote, so a quote is always the speaker's own words; advice that repeats a number already flagged is dropped.

`strengths` must point to the speech (`{text, sentence}`); a strength without a valid sentence number is dropped, so the model can't praise what only the slides show. Main points cite their evidence the same way (`sentences`: up to 2 numbers). The model never copies speech text, except `said` in number checks: copied quotes were about 40% of every answer, and numbers make the answer about a quarter faster (median 7.6 s to 5.6 s on the 5 demo pitches, Gemma 4 E4B, RTX 4060). A text `quote` or `evidence` (older shape, or a model that drifts) is still accepted when it appears in the speech word for word. Tests: `tests/check_sentence_quotes.ts`. `offTopic` is checked on every run, with or without main points.

Model choices: the no-LLM check, Gemma through Ollama (fast, thinking off) and "Gemma · careful" (`ollama-think`, thinking on: about 2x slower and more accurate on main points and numbers in our tests), and Claude.

**Speed.** The reply is streamed: the route sends one JSON line per update (`Accept: application/x-ndjson`), the page shows the summary and list as Gemma writes them, and the checked reply replaces them at the end. Ollama keeps the model loaded (`PITCH_OLLAMA_KEEP_ALIVE`, default always) and the page pre-loads it when it opens. Gemma 4's thinking is off for the fast choice and on for "Gemma · careful". Measured on an RTX 4060 with the 76 s sample: first words after about 3 s, full answer after about 11 s (English) or 16 s (Mongolian); with thinking on, about 21 s and 30 s. In our test, thinking on got all 4 main points right every time; off, it got 3 of 4.

The speech reaches the model as sentences: the voice server returns no punctuation, so a full stop is placed wherever the speaker paused for 0.6 s or more (`textWithPauses` in `web/src/lib/server/voice.ts`).

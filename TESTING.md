# Saylo Testing and Evaluation

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

# Pitchly AI Pipeline

## Goal

Turn a user's recording into a useful transcript-based speaking practice report with evidence and concrete next steps.

## Pipeline

1. **Audio validation**
   - Check supported format, size, duration, and whether the file can be decoded.
   - Reject unsupported files with a clear message.

2. **Speech-to-text**
   - Send audio to the selected ASR provider.
   - Evaluate Mongolian speech performance before committing to a provider.
   - Store the transcript and provider metadata needed for debugging, without storing secrets.

3. **Transcript normalization**
   - Normalize whitespace and obvious formatting issues.
   - Do not silently rewrite the speaker's words.
   - Keep the original transcript available for evidence and comparison.

4. **LLM analysis**
   - Ask one LLM to identify filler words, repetition, unclear wording, organization issues, and practical improvements.
   - Require evidence snippets that exactly match the transcript where possible.
   - Require the improved transcript to preserve the intended meaning.
   - Ask for specific practice tasks, not generic motivational advice.

5. **Output validation**
   - Validate the result with a strict schema.
   - Check that evidence snippets exist in the transcript.
   - Reject or repair malformed output; do not display raw unvalidated model JSON.

6. **Scoring**
   - Calculate category and overall scores using documented rules.
   - Keep scoring deterministic in application code where possible.
   - Treat scores as coaching estimates until validated by human review.

7. **Display**
   - Show the transcript, issues, evidence, improved version, score explanations, and practice tasks.
   - Make uncertainty visible when transcription quality is poor.

## Suggested output contract

```json
{
  "overallScore": 0,
  "categoryScores": {
    "clarity": 0,
    "conciseness": 0,
    "repetition": 0,
    "fillerWords": 0
  },
  "fillerWords": [
    {
      "word": "example",
      "count": 0,
      "evidence": ["exact transcript excerpt"]
    }
  ],
  "issues": [
    {
      "type": "clarity",
      "severity": "low",
      "evidence": "exact transcript excerpt",
      "explanation": "Why this may confuse the audience",
      "suggestion": "A concrete improvement"
    }
  ],
  "improvedTranscript": "Rewritten version preserving the speaker's meaning.",
  "practiceTasks": [
    {
      "title": "Short task",
      "instruction": "A specific action the user can practice.",
      "goal": "What the user should improve"
    }
  ],
  "limitations": []
}
```

The JSON is an example contract. Define and enforce the actual schema in code.

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

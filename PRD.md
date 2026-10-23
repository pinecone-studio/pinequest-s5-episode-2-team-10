# Saylo Product Requirements Document

## 1. Product summary

Saylo helps people improve the clarity and structure of their spoken presentations. The user uploads a recording and receives transcript-based feedback they can act on immediately.

## 2. Problem

People practicing a pitch often do not notice repeated words, filler words, rambling sentences, or unclear explanations. Generic advice is difficult to apply to a specific recording.

## 3. Target users

- Students preparing project or competition pitches
- Startup founders practicing investor presentations
- Job seekers preparing spoken introductions
- People who want structured speaking practice

## 4. MVP user journey

1. Open Saylo.
2. Upload an audio file and confirm that they have permission to process it.
3. See processing status.
4. Read or correct the transcript if transcript editing is supported in the first release.
5. Review feedback with examples linked to transcript excerpts.
6. Read the improved version.
7. Complete practice tasks.
8. Revisit or delete the recording and its data.

## 5. MVP features

### Required
- Audio upload with file validation and clear error states
- Transcription using a model tested for Mongolian speech
- Transcript display
- Detection of filler words and repeated phrases
- Feedback on clarity, conciseness, and organization
- Improved transcript that preserves the speaker's intended meaning
- Overall score and category scores with explanations
- Two or more specific practice tasks based on the recording
- Processing, failure, retry, and empty states
- Recording history and delete action, if accounts are included in the initial build

### Not in MVP
- Live coaching while the user speaks
- Facial-expression or gesture analysis
- Claims that the system can accurately infer confidence or emotion
- Detailed intonation, pitch, loudness, or vocal-quality scoring
- Social feeds, leaderboards, and public sharing

## 6. Feedback principles

- Be specific, respectful, and actionable.
- Show evidence from the transcript for each issue.
- Do not invent quotes or claim a phrase was spoken if it is not in the transcript.
- Preserve the speaker's meaning when rewriting.
- Distinguish a language issue from a possible speech-recognition error.
- If transcription confidence or language support is poor, tell the user rather than presenting uncertain results as fact.

## 7. Initial scoring proposal

Use a 0–100 score as an **experimental coaching indicator**, not an objective measure of a person's speaking ability.

Initial weights:
- Clarity: 35%
- Conciseness and organization: 25%
- Repetition: 20%
- Filler words: 20%

These weights must be tested with human reviewers and adjusted. Avoid penalizing a speaker for dialect, accent, or a transcription error.

## 8. MVP success criteria

- A user can upload a supported audio file and reach a result or a clear error state.
- The transcript and feedback are tied to the correct recording.
- The analysis response passes schema validation before display.
- Feedback examples can be traced to transcript text.
- Users can delete their recordings and associated data.
- A small human-reviewed Mongolian test set is used to evaluate transcription and feedback quality.

## 9. Open decisions

Before implementation, choose:
- Supported audio formats and maximum duration/size
- Login is required: email and password (decided)
- The speech-to-text provider after Mongolian evaluation
- The LLM provider and model
- Retention period for audio and transcript data

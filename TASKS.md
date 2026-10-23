# Saylo MVP Task Plan

## Workstreams

This plan assumes a six-person team. Reassign based on actual skills and availability.

### 1. Product and demo
- [ ] Finalize MVP scope and supported recording length
- [ ] Prepare user journey and demo script
- [ ] Define feedback review rubric
- [ ] Track integration blockers and acceptance criteria

### 2. UI/UX
- [ ] Design project list and project page
- [ ] Design processing/loading states
- [ ] Design transcript and analysis results page
- [ ] Design errors, empty states, and mobile layout
- [ ] Deliver reusable component and spacing/type rules

### 3. Frontend
- [ ] Build project list, project page, and upload flow with client-side validation
- [ ] Connect upload and processing endpoints
- [ ] Display transcript and analysis results
- [ ] Display scores, evidence, improved transcript, and tasks
- [ ] Add retry and delete interactions
- [ ] Test loading, error, and responsive states

### 4. Backend and database
- [ ] Initialize FastAPI application and environment configuration
- [ ] Connect Supabase Postgres (`PITCH_DB_URL`) and add migrations (Alembic) once the schema settles
- [ ] Implement project, attempt, and upload storage (server disk now, Supabase Storage later)
- [ ] Implement status transitions
- [ ] Implement API routes and ownership checks
- [ ] Implement deletion and error handling

### 5. Speech-to-text
- [ ] Collect permissioned Mongolian test audio
- [ ] Compare candidate ASR models/providers
- [ ] Measure WER on corrected reference transcripts
- [ ] Inspect errors by recording conditions and speaking style
- [ ] Integrate the best practical candidate and document limitations

### 6. AI analysis and evaluation
- [ ] Define strict analysis schema (Pydantic, `pipeline/feedback.py`)
- [ ] Write prompt and version it
- [ ] Implement transcript analysis service (Claude and Gemma via Ollama)
- [ ] Identify filler words in context and verify them against the transcript
- [ ] Validate evidence excerpts against the transcript
- [ ] Implement deterministic score calculation
- [ ] Review feedback with humans for correctness and usefulness
- [ ] Build regression examples for common failure modes

## Suggested sequence

1. **Scope and prototype:** finalize user flow, select sample recordings, and prove the ASR path.
2. **Backend foundation:** FastAPI, Supabase Postgres, upload storage, statuses, and API.
3. **AI pipeline:** transcription, analysis schema, evidence validation, scoring.
4. **Frontend integration:** upload, progress, result display, errors, and retry.
5. **Quality pass:** test Mongolian speech, incorrect transcripts, short/long files, and provider failures.
6. **Demo hardening:** seed demo examples, verify secrets, test deployment, and rehearse the demo.

## Definition of done

- The feature matches the MVP scope.
- Input and output are validated.
- Errors are visible and actionable.
- Ownership and data deletion are enforced where applicable.
- Tests or manual verification are documented.
- Relevant documentation is updated.

# Saylo Technical Design

## 1. Architecture

```text
Browser
  |
  v
Next.js Web App
  |
  v
API / Application Service
  |-- Validate upload and user access
  |-- Store audio in private object storage
  |-- Create recording/job in PostgreSQL
  |
  v
Speech-to-Text Provider
  |
  v
Transcript normalization and storage
  |
  v
LLM Analysis Provider
  |
  v
Schema validation + score calculation
  |
  v
PostgreSQL --> Results UI
```

For a hackathon MVP, these steps can run in a single backend application. If processing takes longer than a normal request, use a background job/queue rather than keeping the HTTP request open.

## 2. Recommended implementation choices

- Frontend: Next.js + React + TypeScript
- Styling: Tailwind CSS
- Validation: Zod for API input and AI output
- Database: PostgreSQL + Prisma
- Storage: private S3-compatible object storage
- AI providers: one ASR provider and one LLM provider
- Secrets: environment variables managed by the hosting platform

These are proposed choices, not existing implementation facts. Select one backend approach and avoid building both a separate Express service and duplicate Next.js APIs without a clear reason.

## 3. Processing states

Suggested recording states:
- `UPLOADED`
- `TRANSCRIBING`
- `TRANSCRIBED`
- `ANALYZING`
- `COMPLETED`
- `FAILED`

Persist status changes so the UI can recover after refresh. Store a safe, user-readable failure message separately from internal provider error details.

## 4. Key design rules

- Never expose provider API keys to the browser.
- Validate file size, MIME type, extension, and actual decodability where feasible.
- Keep audio objects private; use short-lived signed URLs only when required.
- Do not trust model output until it passes schema validation.
- Use server-side authorization for every recording read, update, and delete.
- Make retry behavior idempotent where practical to avoid duplicate charges and records.
- Add timeouts and handle provider rate limits.
- Log request IDs and status transitions, but do not log raw audio or full transcripts by default.

## 5. Reliability and cost

- Limit recording duration and upload size for the demo.
- Track transcription and analysis latency and provider errors.
- Cache or reuse completed results for the same recording unless the user explicitly requests re-analysis.
- Keep token/audio usage within configured limits.
- If a provider fails, preserve the recording status and offer a retry.

## 6. Deployment

Deploy the web app and backend to a suitable host, use a managed PostgreSQL database, and configure private object storage. Confirm that the selected host supports the expected audio size, request duration, and background processing model.

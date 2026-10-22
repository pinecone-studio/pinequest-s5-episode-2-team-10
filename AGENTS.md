# Instructions for AI Coding Assistants

## Project context

Saylo is a speaking-practice MVP. A user uploads audio, the app transcribes speech, analyzes the transcript, and displays evidence-based feedback and practice tasks.

Read `README.md`, `PRD.md`, `TECHNICAL_DESIGN.md`, and `AI_PIPELINE.md` before making broad changes.

## Non-negotiable product boundaries

- The MVP is transcript-based.
- Do not claim to measure confidence, emotion, facial expressions, intonation, or vocal quality unless a separately validated feature is implemented.
- Do not fabricate transcript evidence.
- Rewrites must preserve the speaker's intended meaning.
- Treat Mongolian ASR quality as something to measure, not assume.

## Coding rules

- Use TypeScript and keep types explicit at API and AI-provider boundaries.
- Validate external input and model output with Zod or an equivalent schema.
- Keep provider calls on the server. Never expose API keys in client bundles.
- Keep secrets in environment variables and update `.env.example` with variable names only.
- Follow the existing project structure and conventions; do not create duplicate architectures.
- Prefer small reusable components and focused functions.
- Handle loading, empty, success, and failure states in the UI.
- Use accessible labels, keyboard navigation, and responsive layouts.
- Add tests for scoring, validation, ownership checks, and failure cases when those areas change.
- Do not log raw audio, credentials, or full transcripts unless explicitly required for a controlled debugging session.

## Working process

1. Inspect the existing code before editing.
2. State the files and behavior that need to change.
3. Implement the smallest coherent change.
4. Run relevant tests, lint, and type checks when available.
5. Report what changed and any checks that could not be run.
6. Do not claim a command or test passed unless it actually ran successfully.

## Architecture rules

- Use one agreed backend approach: Next.js Route Handlers or a separate Express API.
- Keep AI provider logic behind server-side service modules.
- Keep scoring rules deterministic and documented where practical.
- Persist processing status and handle provider timeouts and retries.
- Enforce recording ownership on every protected operation.
- Do not silently change API contracts or database schema without updating the related docs.

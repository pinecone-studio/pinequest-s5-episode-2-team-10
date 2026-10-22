# Saylo

Saylo is an AI-assisted speaking practice tool. A user uploads a short recording, receives a transcript, reviews actionable feedback about wording and delivery-related language patterns, and practices an improved version.

## MVP goals

- Upload an audio recording.
- Transcribe Mongolian speech using a speech-to-text model selected through testing.
- Analyze the transcript for filler words, repetition, unclear phrasing, and organization.
- Return a structured score, examples from the transcript, an improved version, and practice tasks.
- Let users revisit and delete their recordings and analyses.

## MVP boundaries

The first version focuses on **transcript-based feedback**. It does not claim to reliably evaluate vocal confidence, emotion, facial expression, intonation, or volume. Those require separate audio-feature work and validation.

## Proposed stack

- Web app: Next.js, React, TypeScript
- UI: Tailwind CSS and a consistent component library
- Backend: Next.js Route Handlers or a separate Node.js/Express API; choose one implementation and keep it consistent
- Validation: Zod
- Database: PostgreSQL with Prisma
- Audio storage: private S3-compatible object storage
- AI: one speech-to-text model plus one LLM for transcript analysis

## Core flow

1. User uploads audio.
2. Server validates file type, size, and duration.
3. Audio is sent to the speech-to-text provider.
4. Transcript is stored and shown to the user.
5. The analysis model returns validated structured feedback.
6. The app displays the score, evidence, improved transcript, and practice tasks.

## Getting started

1. Install the project's dependencies.
2. Copy `.env.example` to `.env.local`.
3. Add the required database, storage, and model-provider credentials.
4. Run database migrations.
5. Start the development server.

Exact commands depend on the package manager and backend choice selected during implementation. Do not commit `.env.local` or real API keys.

## Project documents

- `PRD.md`: product scope and user stories
- `TECHNICAL_DESIGN.md`: system architecture and implementation decisions
- `AI_PIPELINE.md`: transcription and analysis behavior
- `DATABASE.md`: entities and relationships
- `API.md`: endpoint contracts
- `AGENTS.md`: instructions for AI coding assistants
- `TASKS.md`: suggested MVP work breakdown
- `TESTING.md`: quality checks and acceptance criteria

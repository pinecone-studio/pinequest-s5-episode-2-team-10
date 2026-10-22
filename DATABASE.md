# Saylo Database Design

This is a proposed MVP schema. Adapt field types and naming to the selected ORM and provider.

## Entities

### User
- `id`: primary key
- `email`: unique, nullable only if anonymous use is deliberately supported
- `createdAt`
- `updatedAt`

### Recording
- `id`: primary key
- `userId`: foreign key to User, nullable only if anonymous sessions are supported
- `originalFileName`
- `storageKey`: private object-storage key, not a public URL
- `mimeType`
- `fileSizeBytes`
- `durationSeconds`
- `status`: enum such as `UPLOADED`, `TRANSCRIBING`, `TRANSCRIBED`, `ANALYZING`, `COMPLETED`, `FAILED`
- `errorCode`: nullable, safe internal code
- `createdAt`
- `updatedAt`
- `deletedAt`: nullable, if soft deletion is used

### Transcript
- `id`: primary key
- `recordingId`: foreign key to Recording
- `text`
- `languageCode`: nullable if not reliably detected
- `provider`
- `providerModel`: nullable
- `createdAt`

### Analysis
- `id`: primary key
- `recordingId`: foreign key to Recording
- `transcriptId`: foreign key to Transcript
- `overallScore`: integer from 0 to 100
- `categoryScores`: JSON or normalized child rows
- `feedback`: validated JSON matching the analysis contract
- `modelProvider`
- `modelName`
- `promptVersion`
- `createdAt`

## Relationships

- A User can own many Recordings.
- A Recording can have one or more Transcript versions if re-transcription is supported.
- A Recording can have one or more Analysis versions if re-analysis is supported.
- Each Analysis references the Transcript version it analyzed.

## Constraints and indexes

- Index `Recording(userId, createdAt)`.
- Index `Recording(status, updatedAt)` for processing/retry workflows.
- Foreign keys must enforce ownership relationships.
- Validate score ranges at the application layer and, where appropriate, in the database.
- Do not store public audio URLs as the source of truth; store a private storage key.
- Ensure delete operations remove or schedule deletion of audio and associated records according to the retention policy.

## Privacy

Document the retention policy before launch. Delete audio and transcript data when the user requests deletion, subject to clearly disclosed operational backups and legal requirements. Restrict access by user ownership on every query.

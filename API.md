# Pitchly API Contract

The following REST endpoints are a proposed MVP contract. They are not implemented endpoints yet. Choose consistent response envelopes and authentication behavior before coding.

## Common rules

- Use JSON for ordinary request/response bodies.
- Use multipart form data for audio upload.
- Authenticate requests if accounts are enabled.
- Verify that the requester owns the recording before returning, reprocessing, or deleting it.
- Return safe error messages; never expose API keys or raw provider exceptions.

## Endpoints

### `POST /api/recordings`
Upload an audio recording.

Request: `multipart/form-data`
- `file`: audio file

Response `201`:
```json
{
  "id": "recording_id",
  "status": "UPLOADED"
}
```

Possible errors: `400` invalid input, `413` file too large, `415` unsupported format, `401` unauthenticated, `500` storage failure.

### `POST /api/recordings/:id/transcribe`
Start transcription, or retry it if the previous attempt failed.

Response `202`:
```json
{
  "recordingId": "recording_id",
  "status": "TRANSCRIBING"
}
```

### `POST /api/recordings/:id/analyze`
Analyze an available transcript.

Response `202`:
```json
{
  "recordingId": "recording_id",
  "status": "ANALYZING"
}
```

Return `409` if no transcript exists yet or the recording is in an incompatible state.

### `GET /api/recordings/:id`
Return recording metadata and current processing status. Do not return private storage credentials.

### `GET /api/recordings/:id/analysis`
Return the latest completed analysis for the recording.

### `GET /api/recordings`
Return the authenticated user's recording history, paginated.

### `DELETE /api/recordings/:id`
Delete the recording and associated transcript/analysis data and schedule or perform deletion of the audio object.

Response `204` on success.

## Error response format

Use one consistent format, for example:
```json
{
  "error": {
    "code": "UNSUPPORTED_AUDIO_FORMAT",
    "message": "This audio format is not supported."
  }
}
```

## Implementation notes

- Validate path parameters, payloads, and provider output.
- Set upload limits and request timeouts.
- Use background processing for slow transcription/analysis when needed.
- Add idempotency or state checks to avoid duplicate work.
- Document exact status codes and pagination fields when implementing.

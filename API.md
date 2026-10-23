# Saylo API Contract

Implemented by the FastAPI server in `backend/main.py`. All paths are under `/api/v1`. Interactive docs run at `/docs` on the API server.

## Common rules

- JSON bodies, except uploads, which are `multipart/form-data` with one `file` field.
- Identity: `POST /auth/register` or `POST /auth/login` returns an access token. The browser sends it as `X-Access-Token` on every other request. A missing or unknown token returns `401`. Login replaces the previous token, so an older sign-in on another device stops working. `POST /auth/logout` does the same without returning a new token.
- Ownership is checked on every project and attempt; anything owned by another user returns `404`, so IDs can't be probed.
- Errors always use this shape, with a message safe to show the user:

```json
{ "code": "no_audio", "message": "Upload or record audio first." }
```

## Users and projects

| Method and path | Does | Response |
| --- | --- | --- |
| `POST /auth/register` | Create an account. `{email, password}` (password 8–128 characters). Email is stored in lowercase | `201 {id, email, access_token}`; `409 email_taken`; `422` for a bad email or short password |
| `POST /auth/login` | Sign in. Same body. Wrong email and wrong password return the same error | `200 {id, email, access_token}`; `401 invalid_credentials` |
| `POST /auth/demo` | Sign in to the shared demo account. Creates it the first time. No body | `200 {id, email, access_token}` |
| `GET /auth/me` | The signed-in account | `{id, email}` |
| `POST /auth/logout` | Forget the current token | `204` |
| `GET /projects` | The user's projects, most recently used first | `[{id, name, goal, audience, idea, key_points, planned_s, pitch_type, created_at, updated_at, attempt_count, latest_overall, processing}]` |
| `POST /projects` | Create a project; every field optional (`name, goal, audience, idea` up to 500 characters, `key_points` up to 6 strings of up to 200 characters (blank ones dropped), `planned_s 30–900, pitch_type startup/academic`) | `201` project with `attempts` and `current` |
| `GET /projects/{id}` | Project, `attempts` (newest first), and `current` = slides and script the next attempt will reuse | project |
| `PATCH /projects/{id}` | Update any detail | project |
| `DELETE /projects/{id}` | Delete the project, attempts, and files | `204`; `409` while an attempt is running |
| `POST /projects/{id}/sessions` | New attempt; copies slides and script from the latest attempt unless `{"copy_inputs": false}` | `201` attempt |

## Attempt inputs and uploads

| Method and path | Does | Errors |
| --- | --- | --- |
| `POST /sessions/{id}/audio` | WAV, MP3, M4A, WebM or OGG; 25 MB; 3 s to 5 min. Returns `{duration_s, format}` | `400` unreadable, `409` busy, `413` too large or long, `415` format |
| `POST /sessions/{id}/slides` | PDF or PPTX; 20 MB; 40 slides. Returns `{slide_count, image_only, filename}` | `400`, `409`, `413`, `415` |
| `DELETE /sessions/{id}/slides` | Remove slides from this attempt | `409` busy |
| `PUT /sessions/{id}/script` | `{text}` up to 20,000 characters. Returns `{words}` | `409` busy |
| `GET /sessions/{id}/audio` | The recording as uploaded | `404` |
| `GET /sessions/{id}/slides` | `{filename, slides: [{number, text, notes, image_only}]}` | |
| `GET /sessions/{id}/slides/file` | The uploaded deck | `404` |
| `GET /sessions/{id}/script` | `{text}` | |

## Analysis

| Method and path | Does | Response |
| --- | --- | --- |
| `POST /sessions/{id}/analyze` | `{feedback_backend?}`: `claude`, `gemma4-ft`, `gemma4-base`, `rules` (default from `PITCH_DEFAULT_BACKEND`). Uses the project's current details | `202 {status, queue_position}`; `409` without audio or while running; `422` unknown model |
| `GET /sessions/{id}/status` | `{status, stage, queue_position, error}` | |
| `GET /sessions/{id}/report` | The report (below) | `409` until completed |
| `GET /sessions/compare?a=&b=` | Changes in scores and metrics between two of the user's attempts | `{a, b, changes: {field: {a, b, delta}}}` |
| `DELETE /sessions/{id}` | Delete one attempt | `204`; `409` while running |
| `GET /health` | Configured speech-to-text, embeddings, and default model | |

### Report

```json
{
  "session_id": "…", "project_id": "…", "title": "…",
  "overall": 72, "content": 68, "delivery": 61, "slide_alignment": 75, "timing": 90,
  "categories_used": 4,
  "delivery_parts": { "pace": 80, "fillers": 63, "pauses": 100, "pitch_range": 40, "volume_end": 100 },
  "metrics": { "duration_s": 182.4, "wpm": 142.2, "fillers_per_100": 2.86, "long_pauses_per_min": 0.3, "pitch_range_st": 5.1, "end_volume_drop_db": 2.0 },
  "wording": { "word_count": 412, "filler_total": 12, "list_filler_total": 14, "repeats": 3, "…": "…" },
  "slide_results": { "method": "e5", "coverage": 0.75, "slides": ["…"], "number_candidates": ["…"] },
  "feedback": {
    "summary": "…", "strengths": ["…"],
    "content_scores": [{ "criterion": "problem", "score": 80, "evidence": "exact quote", "recommendation": "…" }],
    "slide_feedback": [{ "slide": 3, "status": "missed", "comment": "…" }],
    "number_checks": [{ "slide": 4, "on_slide": "25%", "said": "гучин хувь", "inconsistent": true }],
    "recommendations": [{ "area": "structure", "problem": "…", "start_s": 84.2, "slide": 5, "why": "…", "action": "…", "example_sentence": "…", "impact": "high" }],
    "filler_occurrences": [{ "sentence_id": 1, "word": "ээ" }],
    "fillers": {
      "method": "llm", "total": 12, "per_100": 2.91, "model_reported": 13, "note": null,
      "words": [{ "word": "ээ", "count": 7, "evidence": ["…"], "occurrences": [{ "sentence_id": 1, "start_s": 3.1 }] }]
    },
    "point_checks": [{ "point": 0, "status": "covered", "evidence": "exact quote", "note": "" }],
    "off_topic": [{ "sentence_id": 1, "reason": "…" }],
    "idea_comment": "…",
    "main_points": {
      "method": "llm", "coverage": 67, "idea_comment": "…",
      "points": [{ "point": 0, "text": "the project's main point", "status": "covered", "verified": true, "evidence": "exact quote", "note": "" }],
      "off_topic": [{ "sentence_id": 1, "start": 6.9, "text": "sentence quoted by code", "reason": "…" }]
    }
  },
  "transcript": { "text": "…", "sentences": [{ "text": "…", "start": 0.0, "end": 2.8 }] },
  "script": "…", "slides_filename": "deck.pptx",
  "backend": "claude", "asr_backend": "whisper", "prompt_version": "v2.2-points",
  "notes": [], "created_at": "2026-10-22T03:51:46+00:00"
}
```

Category scores are `null` when there is no data (for example no slides); `overall` is then reweighted over the categories that exist, and `categories_used` says how many.

## Changing the contract

Update this file, `server/README.md`, and `web/src/lib/types.ts` together with the code.

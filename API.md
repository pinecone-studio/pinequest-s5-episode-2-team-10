# Saylo API Contract

Implemented by the FastAPI server in `backend/main.py`. All paths are under `/api/v1`. Interactive docs run at `/docs` on the API server.

## Common rules

- JSON bodies, except uploads, which are `multipart/form-data` with one `file` field.
- Identity: `POST /auth/register`, `POST /auth/login`, `POST /auth/demo`, or `POST /auth/google` returns an access token. The browser sends it as `X-Access-Token` on every other request. A missing or unknown token returns `401`. Login and Google sign-in replace the previous token, so an older sign-in on another device stops working. Demo sign-in does not: each computer keeps its own token for the shared account. `POST /auth/logout` forgets only the token that was sent.
- Members can access only their own projects and attempts; another user's IDs return `404`. Admins can access all projects and attempts.
- Admin-only user management endpoints list users and update roles or account status. Admin status never comes from user input at registration.
- In shared Postgres mode, audio and slide files are read from a private Supabase Storage bucket by FastAPI after ownership checks. Storage errors return the standard error body with `503 storage_unavailable`.
- Errors always use this shape, with a message safe to show the user:

```json
{ "code": "no_audio", "message": "Upload or record audio first." }
```

## Users and projects

| Method and path | Does | Response |
| --- | --- | --- |
| `POST /auth/register` | Create an account. `{email, username, password}` (username 1–40 characters, any characters; password 8–128 characters). Email and username are normalized and unique regardless of case; role is always `member` | `201 {id, email, username, role, access_token}`; `409 email_taken`; `409 username_taken`; `422 invalid_email`; `422 invalid_username`; `422` for a short password |
| `POST /auth/login` | Sign in. `{login, password}`, where `login` is the email (contains `@`) or the username. A wrong identifier and a wrong password return the same error | `200 {id, email, username, role, access_token}`; `401 invalid_credentials` |
| `POST /auth/demo` | Sign in to the shared demo administrator account from any browser. Creates it the first time and ensures its role is `admin`. No body. Earlier demo sign-ins stay valid | `200 {id, email, username: null, role: "admin", access_token}` |
| `POST /auth/google` | Sign in with Google. `{access_token}` is the Supabase Auth token from the Google redirect; the server checks it with Supabase (`GET /auth/v1/user`) and accepts only a confirmed email from the `google` provider. An existing account with that email is reused, otherwise one is created without a password or username | `200 {id, email, username, role, access_token}`; `401 invalid_google_token`; `502 google_unreachable`; `503 google_disabled` when `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` are unset |
| `GET /auth/me` | The signed-in account. `has_password` is false for accounts that only sign in with Google | `{id, email, username, role, has_password}` |
| `PATCH /auth/me` | Update only the signed-in user's `{username}` (1–40 characters, normalized and unique). Shared demo account is read-only | `{id, email, username, role, has_password}`; `401 unauthorized`; `403 shared_account_readonly`; `409 username_taken`; `422 invalid_username` |
| `POST /auth/me/password` | Change the password: `{current_password, new_password}` (new: 8–128 characters). An account without a password (Google only) sets its first one and may omit `current_password`. Other devices are signed out; the token that sent the request keeps working. Shared demo account is read-only | `204`; `400 wrong_password` (not `401`, so the web app keeps the session); `401 unauthorized`; `403 shared_account_readonly`; `422 same_password`; `422` for a short password |
| `PUT /auth/me/avatar` | Upload a JPG, PNG, or WebP profile image (max 5 MB); the server validates and resizes it | `204`; `401 unauthorized`; `403 shared_account_readonly`; `413 avatar_too_large`; `415 invalid_avatar`; `503 storage_unavailable` |
| `GET /auth/me/avatar` | Read the signed-in user's private profile image; the shared demo account receives the built-in demo avatar | WebP image; `204` (empty) when no photo has been uploaded; `404 avatar_not_found` when a saved photo is missing; `503 storage_unavailable` |
| `POST /auth/logout` | Forget the current token | `204` |
| `GET /admin/users` | List accounts (admin only) | `[{id, email, role, is_active, created_at, trial_ends_at, paid_until}]`; `403 admin_required` |
| `GET /admin/status?test_gemma=` | Whether each part the analysis needs is up (admin only). Checks run in parallel with 5 s timeouts; a dead service is reported, never an error. `test_gemma=true` also asks Gemma for a one-word reply (up to 2 min if the model has to load). No addresses or tokens are returned | `{backend: {ok, queue_length, analysing}, database: {ok, ms, error?}, voice: {ok, ms, where: "local"\|"remote", used, model_loaded?, model?, device?, cuda?, busy?, error?}, ollama: {ok, ms, where, version?, model?, installed?, loaded?, gpu_share?, error?}, gemma_test: {ok, ms, tokens_per_s?, error?} \| null}`; `403 admin_required` |
| `GET /admin/status/deployed?lang=mn\|en` | Public checks of the deployed site, made by this backend (a page on a local build can't read the deployed site directly): is the web app up (`PITCH_DEPLOYED_SITE_URL`), does it reach its voice server (its `GET /api/transcribe`, answered in `lang`), is its backend up (`PITCH_DEPLOYED_API_URL` `/health`, waiting up to 60 s for a sleeping host) and does that backend have `/admin/status` yet. Admin only | `{site_url, web: {ok, ms, error?}, web_voice: {ok, ms, reachable, model_loaded, device, busy, error?}, backend: {ok, ms, gemma: {ok, model, installed, loaded, gpu_share, error?} | null, queue_length, asr, default_backend, has_status_check, error?}}`; `403 admin_required` |
| `PATCH /admin/users/{user_id}` | Set `{role?: "member" \| "admin", is_active?: boolean, grant_days?: 1–365}` (admin only). `grant_days` adds paid days the same way a payment does (for example after a bank transfer). Disabling an account revokes its app tokens; it must sign in again after reactivation. An admin cannot change their own account, remove a configured admin, or deactivate/demote the last active admin | updated user; `404` unknown account; `409` protected admin update; `403 admin_required` |
| `GET /projects` | A member's own projects, or all projects for admins, most recently used first | `[{id, name, goal, audience, idea, key_points, planned_s, pitch_type, created_at, updated_at, attempt_count, latest_overall, processing}]`; admin results also include `owner_id, owner_email` |
| `POST /projects` | Create a project; every field optional (`name, goal, audience, idea`, `key_points`, `point_slides`, `figma_url`, `script`, `planned_s`, `pitch_type`) | `201` project with `attempts` and `current` |
| `GET /projects/{id}` | Project, all `attempts` (newest first, including saved uploads not yet analyzed), and `current` = latest session inputs | project; admin responses also include `owner_id, owner_email` |
| `PATCH /projects/{id}` | Update project details, saved script, and selected audio take | project |
| `DELETE /projects/{id}` | Delete the project, attempts, and files | `204`; `409` while an attempt is running; `503` storage unavailable |
| `POST /projects/{id}/sessions` | New attempt; copies slides and script from the latest attempt unless `{"copy_inputs": false}` | `201` attempt; `503` storage unavailable |

## Subscription (free trial, then QPay)

A new account gets a free trial (`PITCH_TRIAL_DAYS`, 7). After that, each QPay payment adds one period (`PITCH_SUBSCRIPTION_DAYS`, 30) after whichever is later: now, the trial's end, or the paid period's end. Admins and the shared demo account are never charged.

When the trial and paid period are over **and** `PITCH_BILLING_ENFORCED=true`, these return `402 subscription_required`: `POST /projects`, `POST /projects/{id}/sessions`, `POST /sessions/{id}/audio`, `POST /sessions/{id}/slides`, `PUT /sessions/{id}/script`, `POST /sessions/{id}/analyze`. Reading, renaming (`PATCH /projects/{id}`), and deleting stay open. The web app's AI routes (`/api/prototype`, `/api/transcribe`, `/api/tts`, `/api/slides/convert`) check the same state through `GET /billing/status` and answer `402` too.

| Method and path | Does | Response |
| --- | --- | --- |
| `GET /billing/status` | The signed-in account's state: `admin`, `trial`, `active`, or `expired` | `{state, allowed, trial_ends_at, paid_until, ends_at, days_left, price_mnt, period_days, enforced, payments_enabled}` |
| `POST /billing/invoice` | Creates a QPay invoice for one period. A pending invoice younger than 10 minutes is returned again instead of a new one | `201 {id, status, amount_mnt, period_days, created_at, paid_at, expires_at, qr_image, qr_text, short_url, bank_links: [{name, logo, link}]}`; `409 billing_not_needed` for admin/demo; `502 payment_unavailable`; `503 payments_disabled` when the price or QPay credentials are unset |
| `GET /billing/payments` | The account's last 20 payments, newest first | `[payment]` |
| `GET /billing/payments/{id}` | Asks QPay whether this invoice is paid; if so, marks it paid and extends access exactly once. The browser polls this every 3 s while the QR code is open. A QPay outage leaves it pending rather than failing | `{payment, billing}`; `404` another user's payment |
| `GET` or `POST /billing/qpay/callback?payment_id=` | QPay's notification after a payment. No token; nothing in the request is trusted: the server asks QPay directly before granting anything. An invoice older than 10 minutes that is paid late is still credited here | `200 {ok: true}` always |

A payment is credited only when QPay reports `PAID` for at least the invoice amount. Moving the row from `pending` to `paid` is a conditional update, so the callback and a poll arriving together extend access once.

## Attempt inputs and uploads

| Method and path | Does | Errors |
| --- | --- | --- |
| `POST /sessions/{id}/audio` | WAV, MP3, M4A, WebM or OGG; 25 MB; 3 s to 5 min. Returns `{duration_s, format}` | `400` unreadable, `409` busy, `413` too large or long, `415` format, `503` storage unavailable |
| `DELETE /sessions/{id}/audio` | Delete only the saved recording and its report/transcript, retaining the attempt and slides | `204`; `404` another user's attempt; `409` while running; `503` storage unavailable |
| `POST /sessions/{id}/slides` | PDF or PPTX; 20 MB; 40 slides. Returns `{slide_count, image_only, filename}` | `400`, `409`, `413`, `415`, `503` storage unavailable |
| `DELETE /sessions/{id}/slides` | Remove slides from this attempt | `409` busy, `503` storage unavailable |
| `PUT /sessions/{id}/script` | `{text}` up to 20,000 characters. Returns `{words}` | `409` busy |
| `GET /sessions/{id}/audio` | The recording as uploaded | `404` missing object, `503` storage unavailable |
| `GET /sessions/{id}/slides` | `{filename, slides: [{number, text, notes, image_only}]}` | |
| `GET /sessions/{id}/slides/file` | The uploaded deck | `404` missing object, `503` storage unavailable |
| `GET /sessions/{id}/script` | `{text}` | |

## Analysis

| Method and path | Does | Response |
| --- | --- | --- |
| `POST /sessions/{id}/analyze` | `{feedback_backend?}`: `claude`, `gemma4-ft`, `gemma4-base`, `rules` (default from `PITCH_DEFAULT_BACKEND`). Uses the project's current details | `202 {status, queue_position}`; `409` without audio or while running; `422` unknown model |
| `GET /sessions/{id}/status` | `{status, stage, queue_position, error}` | |
| `GET /sessions/{id}/report` | The report (below) | `409` until completed |
| `GET /sessions/compare?a=&b=` | Changes in scores and metrics between two of the user's attempts | `{a, b, changes: {field: {a, b, delta}}}` |
| `DELETE /sessions/{id}` | Delete one attempt | `204`; `409` while running; `503` storage unavailable |
| `GET /health` | Configured speech-to-text, embeddings, default model, queue length, and `gemma`: `{ok, model, installed, loaded, gpu_share, error?}` (no address; checked at most every 30 s) | |

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
    "practice_tasks": [
      { "title": "Гол санаагаа цэгцлэх", "instruction": "Илтгэлийн гол санаагаа 30 секундэд ярьж бич.", "goal": "Гол санааг товч ойлгуулах." },
      { "title": "Төгсгөлөө давтах", "instruction": "Илтгэлийн төгсгөлийн өгүүлбэрээ давтан хэл.", "goal": "Дүгнэлтээ тодорхой хүргэх." }
    ],
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
  "backend": "claude", "asr_backend": "whisper", "prompt_version": "v2.3-practice-tasks",
  "notes": [], "created_at": "2026-10-22T03:51:46+00:00"
}
```

Category scores are `null` when there is no data (for example no slides); `overall` is then reweighted over the categories that exist, and `categories_used` says how many.

## Roles

Accounts default to `member`. The shared `POST /auth/demo` account is an exception: anyone can use the demo button, and it receives `admin` access. Other admins can be bootstrapped only through the server-configured comma-separated `PITCH_ADMIN_EMAILS` allowlist and a verified Supabase Google sign-in. Admins may promote/demote other users and enable/disable accounts through the admin endpoint. Allowlisted admins cannot be demoted through the API; remove an email from server configuration and then use the admin endpoint to change its stored role. At least one active admin must remain.

Admin access bypasses project ownership checks and includes private audio, slides, transcripts, and reports. Treat admin membership as trusted access to all user content. The browser never assigns roles; all authorization is enforced by FastAPI.

## Changing the contract

Update this file, `server/README.md`, and `web/src/lib/types.ts` together with the code.

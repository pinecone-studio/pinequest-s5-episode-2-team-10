# AI Pitch Coach: web

Next.js + TypeScript + Tailwind front end for the pitch coach (TDD v2).

```bash
npm install
npm run dev          # http://localhost:3000
```

Without `NEXT_PUBLIC_API_URL` the app runs in **demo mode**: a mock backend in the browser
walks through the analysis stages and returns a sample report. To use the FastAPI server,
copy `.env.example` to `.env.local` and set the URL.

## Screens

- `/`: session details, slides (PDF/PPTX), audio (upload or record in the browser),
  feedback model choice, then Analyze.
- `/sessions/[id]`: polls status every 2 s, shows the stage, then the report.

## What the front end expects from the API

All under `/api/v1`, as in the TDD. Points the TDD leaves open, decided here:

| Item | Choice |
| --- | --- |
| Access token header | `X-Access-Token` (token kept in local storage per session) |
| Upload field name | `file` (multipart) for both `/audio` and `/slides` |
| Feedback model | `POST /sessions/{id}/analyze` body `{"feedback_backend": "claude" \| "gemma4-ft" \| "gemma4-base"}` |
| `/slides` response | `{"slide_count", "image_only": [numbers]}` |
| `/audio` response | `{"duration_s", "format"}` |
| `/report` response | flat category scores (`overall`, `content`, `delivery`, `slide_alignment`, `timing`, null when missing) plus `title`, `metrics`, `feedback` (schema v2), `transcript.sentences`, `backend` |

Types are in `src/lib/types.ts`; change them there if the server contract differs.
Browser recordings are WebM/Opus (MP4 on Safari); the server converts to 16 kHz WAV.

Not built yet: the compare screen (`/sessions/compare`) and delete.

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

- `/`: main menu. Every project (folder) with its latest score, attempt count and last update, plus **New project**.
- `/projects/[id]`: the project screen.
  - Left: project details (saved as you leave each field), then the new attempt: slides (reused from the last attempt unless replaced), optional script, recording (upload or record), feedback model and **Analyze pitch**.
  - Right: every attempt with its score and change from the previous one, and the selected attempt's AI suggestions, followed by its uploads (recording playback, slide text and download, script).

## What the front end expects from the API

The project endpoints are listed in `server/README.md`. In short:

| Item | Choice |
| --- | --- |
| Identity | `POST /auth/register` or `POST /auth/login`; token kept in local storage and sent as `X-Access-Token` |
| Projects | `GET/POST /projects`, `GET/PATCH/DELETE /projects/{id}` |
| Attempts | `POST /projects/{id}/sessions` copies the last attempt's slides and script, then the usual uploads and `analyze` |
| Script | `PUT /sessions/{id}/script` |
| Viewing uploads | `GET /sessions/{id}/audio`, `/slides`, `/slides/file`, fetched as blobs because `<audio>` can't send the token header |

If the server forgets the token (for example after the database is reset), the app returns to the sign-in screen.

Types are in `src/lib/types.ts`; change them there if the server contract differs.
Browser recordings are WebM/Opus (MP4 on Safari); the server converts to 16 kHz WAV.

Sign-in is required. Folders saved in this browser are kept per account and do not follow the user to another device.

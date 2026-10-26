# Saylo voice server

Runs the Mongolian speech-to-text model (BuzzASR, fine-tuned Whisper large-v3) on a PC with
an NVIDIA GPU, so the app doesn't need a paid STT API. The API uses it with `PITCH_ASR=remote`.
A Cloudflare tunnel makes it reachable from anywhere (a teammate's laptop, a hosted API).

```text
API (PITCH_ASR=remote) --HTTPS--> Cloudflare tunnel --> voice server :8001 --> GPU
```

## Setup (once)

Needs Python 3.12, an NVIDIA GPU with 8 GB, ffmpeg (or the `imageio-ffmpeg` package), and
about 8 GB of disk for PyTorch and the model. Put the env on a drive with space:

```powershell
uv venv --python 3.12 B:\pinequest-data\voice-venv
uv pip install --python B:\pinequest-data\voice-venv\Scripts\python.exe torch --index-url https://download.pytorch.org/whl/cu128
uv pip install --python B:\pinequest-data\voice-venv\Scripts\python.exe -r voice\requirements.txt
scoop install cloudflared          # or: winget install Cloudflare.cloudflared
```

The model (about 3 GB) downloads from Hugging Face on first start.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File scripts\voice.ps1 -Tunnel
```

The first run creates `.env.voice` (not committed) with a random `VOICE_SERVER_TOKEN` and the
venv path. The script prints the public URL. On the machine running the API, set:

```bash
PITCH_ASR=remote
PITCH_VOICE_URL=https://<printed>.trycloudflare.com
PITCH_VOICE_TOKEN=<VOICE_SERVER_TOKEN from .env.voice>
```

Without `-Tunnel` it's local only (`http://127.0.0.1:8001`), which is enough when the API runs on the same PC.

**Stable URL.** The quick tunnel gets a new random URL each run. For a fixed one you need a
domain on a Cloudflare account:

```powershell
cloudflared tunnel login                       # opens the browser
cloudflared tunnel create saylo-voice
cloudflared tunnel route dns saylo-voice voice.<your-domain>
```

Then set `VOICE_TUNNEL_NAME=saylo-voice` in `.env.voice`, and `PITCH_VOICE_URL=https://voice.<your-domain>`.

## API

| Method and path | Does |
| --- | --- |
| `GET /health` | `{ok, model, model_loaded, cuda, device, busy}`. No token needed |
| `POST /v1/transcribe` | Multipart `file` (any format ffmpeg reads, 25 MB, 5 min). Header `Authorization: Bearer <token>`. Returns `{words: [{word, start, end, db?}], duration_s, model, elapsed_s}`; `db` is the word's loudness (dB below full scale, see `pipeline/loudness.py`) |

Errors are `{"code", "message"}`: 401 wrong token, 400 bad/empty/too long audio, 413 too large,
503 model not available. One file is transcribed at a time (one GPU).

## How it transcribes

- Audio is cut at pauses into sentence-sized pieces (about 12 s, never over 28 s). BuzzASR was
  trained on short clips and skips sentences when given 30 s at once.
- Pieces with no sound are skipped, because Whisper models invent text on silence.
- **Word timings are estimates.** BuzzASR replaced Whisper's tokenizer, which breaks Whisper's
  own word timestamps, so words are spread over the parts of each piece that have sound. Pauses
  between sentences land in the right place; times inside a sentence are approximate. Reports say so.

Quick check on public Common Voice clips (6 sentences, 35 s): 42 of 47 words right, 1.9 s on an
RTX 4060. This is not an evaluation; measure on our own recordings as `TESTING.md` describes.

The server logs only durations and word counts, never transcripts or audio.

## Running a demo on this PC

```powershell
powershell -ExecutionPolicy Bypass -File scripts\demo.ps1          # start or restart everything, then check it
powershell -ExecutionPolicy Bypass -File scripts\demo.ps1 -Stop    # stop it
```

It starts the voice server, the FastAPI backend (full analysis with local Gemma by default; `-FeedbackModel rules` for no LLM), the web app and Ollama if needed, checks each one, and pre-loads Gemma. Logs are in `data\demo-logs`. Add `-Tunnel` for a public voice-server URL.

## Remote access to this PC

`scripts\setup-remote-ssh.ps1` (run once in an administrator PowerShell) sets up SSH with key login only, reachable only through Tailscale, and turns off sleep while plugged in. Windows 11 Home has no Remote Desktop host, so SSH is the way in; for a screen, use Chrome Remote Desktop. From the laptop: `ssh <user>@<tailscale address>`, or VS Code's Remote-SSH to edit and run code here.

## Using this PC from the deployed site (Vercel + Railway)

The deployed apps can't reach `localhost`, so this PC is published with Tailscale Funnel at a fixed HTTPS address (it survives restarts):

| Public path | Goes to | Protected by |
| --- | --- | --- |
| `https://ddd5.tail9b3d3b.ts.net/` | FastAPI backend (8000) | nothing: anyone with the link can use it |
| `https://ddd5.tail9b3d3b.ts.net/voice` | voice server (8001) | `VOICE_SERVER_TOKEN` |
| `https://ddd5.tail9b3d3b.ts.net/voice/v1/ollama` | Ollama (Gemma), through the voice server | `VOICE_SERVER_TOKEN` |

Set up once (administrator not needed): `tailscale funnel --bg 8000` and `tailscale funnel --bg --set-path /voice http://127.0.0.1:8001`. Run them from PowerShell; Git Bash rewrites `/voice` into a Windows path.

**Vercel** (Project → Settings → Environment Variables, then redeploy):

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | `https://ddd5.tail9b3d3b.ts.net` (this PC's backend; or the Railway URL, see below) |
| `PITCH_VOICE_URL` | `https://ddd5.tail9b3d3b.ts.net/voice` |
| `PITCH_VOICE_TOKEN` | the `VOICE_SERVER_TOKEN` from `.env.voice` on this PC |
| `OLLAMA_URL` | `https://ddd5.tail9b3d3b.ts.net/voice/v1/ollama` |
| `OLLAMA_TOKEN` | the same token |
| `PITCH_OLLAMA_MODEL_BASE` | `gemma4:e4b` |

PowerPoint conversion needs LibreOffice, which Vercel doesn't have: on the deployed site, upload slides as PDF.

**Railway**, only if `NEXT_PUBLIC_API_URL` points at Railway instead of this PC: `PITCH_ASR=remote`, `PITCH_VOICE_URL`, `PITCH_VOICE_TOKEN`, `OLLAMA_URL`, `OLLAMA_TOKEN` as above, and `PITCH_DEFAULT_BACKEND=gemma4-base`.

When the demo is over: `tailscale funnel reset`.

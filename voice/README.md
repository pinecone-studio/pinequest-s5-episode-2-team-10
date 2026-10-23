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
| `POST /v1/transcribe` | Multipart `file` (any format ffmpeg reads, 25 MB, 5 min). Header `Authorization: Bearer <token>`. Returns `{words: [{word, start, end}], duration_s, model, elapsed_s}` |

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

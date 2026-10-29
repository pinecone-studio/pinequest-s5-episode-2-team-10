"""The three example takes, spoken by the app's coach voice (ElevenLabs, Mongolian) through the running
web app's /api/tts. Sentences are sped up with ffmpeg atempo where the take says so, and joined with
the given pauses. Writes take1..3.wav (16 kHz mono) next to this file.

    python make_takes_eleven.py <ffmpeg>
"""
import subprocess
import sys
import wave
from pathlib import Path

import httpx
import numpy as np

from takes_text import TAKES

OUT = Path(__file__).parent
FFMPEG = sys.argv[1]
SR = 16000

token = httpx.post("http://localhost:8000/api/v1/auth/demo", timeout=30).json()["access_token"]
client = httpx.Client(timeout=120, headers={"X-Access-Token": token, "x-pitch-lang": "mn"})


def to_wav(src: Path, dst: Path, speed: float):
    filters = ["-ar", str(SR), "-ac", "1"]
    if speed != 1.0:
        filters = ["-filter:a", f"atempo={speed}", *filters]
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", str(src), *filters, "-sample_fmt", "s16", str(dst)], check=True)


def read(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32767


ONLY = set(sys.argv[2:])  # take names to (re)make; all when empty
for take, sentences in TAKES.items():
    if ONLY and take not in ONLY:
        continue
    pieces = [np.zeros(int(SR * 0.4), dtype=np.float32)]
    for i, (text, pause, speed) in enumerate(sentences):
        r = client.post("http://localhost:3000/api/tts", json={"text": text, "engine": "elevenlabs"})
        if r.status_code != 200:
            sys.exit(f"{take} sentence {i + 1}: HTTP {r.status_code} {r.text[:200]}")
        mp3, wav = OUT / f"_tmp_{i}.mp3", OUT / f"_tmp_{i}.wav"
        mp3.write_bytes(r.content)
        to_wav(mp3, wav, speed)
        pieces += [read(wav), np.zeros(int(SR * pause), dtype=np.float32)]
        mp3.unlink()
        wav.unlink()
    audio = np.concatenate(pieces)
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(OUT / f"{take}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(take, f"{len(audio) / SR:.1f} s")

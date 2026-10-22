"""Convert any upload to 16 kHz mono WAV with ffmpeg."""

import shutil
import subprocess
import wave
from pathlib import Path


class AudioError(Exception):
    pass


def ffmpeg_path() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:  # pragma: no cover - depends on the machine
        raise AudioError("ffmpeg is not installed on the server.") from e


def to_wav16k(src: Path, dst: Path) -> float:
    """Convert src to 16 kHz mono 16-bit WAV at dst. Returns the duration in seconds."""
    cmd = [ffmpeg_path(), "-y", "-v", "error", "-i", str(src), "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", str(dst)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not dst.exists():
        raise AudioError("Could not read this audio file. Try WAV, MP3, M4A, WebM or OGG.")
    return wav_duration(dst)


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())

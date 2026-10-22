"""Voice metrics: pace, pauses, pitch range, volume drop at the end."""

import math
from pathlib import Path

import numpy as np

from .segments import Word

LONG_PAUSE_S = 2.0
END_PORTION = 0.2  # last 20% of speech is compared with the rest for volume drop


def measure(wav: Path, words: list[Word], duration_s: float) -> dict:
    speech_s = (words[-1]["end"] - words[0]["start"]) if words else 0.0
    gaps = [b["start"] - a["end"] for a, b in zip(words, words[1:])]
    long_pauses = [g for g in gaps if g >= LONG_PAUSE_S]

    result = {
        "duration_s": round(duration_s, 2),
        "speech_s": round(speech_s, 2),
        "wpm": round(len(words) / (speech_s / 60), 1) if speech_s > 5 else None,
        "long_pauses": len(long_pauses),
        "long_pauses_per_min": round(len(long_pauses) / (duration_s / 60), 2) if duration_s > 0 else None,
        "pitch_range_st": None,
        "end_volume_drop_db": None,
    }
    result.update(_voice(wav))
    return result


def _voice(wav: Path) -> dict:
    try:
        import parselmouth
    except ImportError:
        return {}

    snd = parselmouth.Sound(str(wav))
    out: dict = {}

    f0 = snd.to_pitch().selected_array["frequency"]
    f0 = f0[f0 > 0]
    if len(f0) > 20:
        lo, hi = np.percentile(f0, [10, 90])
        out["pitch_range_st"] = round(12 * math.log2(hi / lo), 1)

    intensity = snd.to_intensity()
    db = intensity.values[0]
    voiced = db[db > db.max() - 25]  # ignore silence
    if len(voiced) > 20:
        cut = int(len(voiced) * (1 - END_PORTION))
        out["end_volume_drop_db"] = round(float(np.mean(voiced[:cut]) - np.mean(voiced[cut:])), 1)

    return out

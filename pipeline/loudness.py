"""How loud each word was, so delivery checks can spot a voice trailing off.

Levels are dB relative to full scale (always negative). They depend on the microphone and its
distance, so only compare words within one recording, never against a fixed level.
Word times are estimates (see word_timing), so a word's span can overlap the silence next to
it. Its level is therefore the loud end of its frames (90th percentile), not the average, so
a short last word before a pause isn't read as quiet just because its span includes silence.
"""

import numpy as np

from .segments import Word

FRAME_S = 0.02
SILENCE_MARGIN_DB = 6.0  # a word none of whose frames is this far above the background has no level
LEVEL_PERCENTILE = 90
SPEECH_RANGE_DB = 25.0  # sound within this much of the loudest speech always counts
FLOOR_DB = -100.0


def frame_db(samples: np.ndarray, sr: int) -> np.ndarray:
    """Loudness of each 20 ms frame, in dB relative to full scale."""
    hop = max(1, int(sr * FRAME_S))
    n = len(samples) // hop
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    frames = samples[: n * hop].reshape(n, hop).astype(np.float64)
    rms = np.sqrt(np.mean(frames**2, axis=1))
    return np.maximum(20 * np.log10(np.maximum(rms, 1e-10)), FLOOR_DB).astype(np.float32)


def word_levels(samples: np.ndarray, sr: int, words: list[Word]) -> list[float | None]:
    """Level (dB) of each word: the 90th percentile of its frames; None when it has no sound."""
    db = frame_db(samples, sr)
    if len(db) == 0:
        return [None] * len(words)
    noise = float(np.percentile(db, 10))  # the quiet background between words
    peak = float(np.percentile(db, 95))
    # Capped below the speech level, so a recording with no silence in it still counts its sound.
    threshold = min(noise + SILENCE_MARGIN_DB, peak - SPEECH_RANGE_DB)
    out: list[float | None] = []
    for w in words:
        lo = max(0, int(w["start"] / FRAME_S))
        hi = min(len(db), max(lo + 1, int(np.ceil(w["end"] / FRAME_S))))
        span = db[lo:hi]
        heard = len(span) and float(span.max()) > threshold
        out.append(round(float(np.percentile(span, LEVEL_PERCENTILE)), 1) if heard else None)
    return out

"""Find where a recording has sound, cut it into model-sized pieces, and estimate word times.

Used by the local Whisper backend. BuzzASR replaced Whisper's tokenizer, so Whisper's own
word timestamps don't work with it; instead words are spread over the parts of the audio
that have sound, in proportion to their length. Pauses therefore land where the speaker
was actually silent, but times inside a stretch of speech are estimates.
"""

import numpy as np

from .segments import Word

FRAME_S = 0.02
MIN_GAP_S = 0.15  # shorter silences count as speech
MIN_SPEECH_S = 0.25  # a piece with less sound than this is skipped (Whisper invents text on silence)
MAX_CHUNK_S = 28.0  # Whisper reads at most 30 s at a time
SOFT_MAX_S = 12.0
MIN_PIECE_S = 2.0
PAUSE_SPLIT_S = 0.4
EDGE_PAD_S = 0.2

Span = tuple[float, float]


def voiced_spans(samples: np.ndarray, sr: int) -> list[Span]:
    """Time ranges (seconds) where the audio is louder than the background."""
    hop = int(sr * FRAME_S)
    n = len(samples) // hop
    if n == 0:
        return []
    frames = samples[: n * hop].astype(np.float32).reshape(n, hop)
    rms = np.sqrt(np.mean(frames**2, axis=1))
    # Compare against the background noise only, so a quiet speaker still counts as sound.
    # Exact digital silence (padding, muted mic) would make the floor zero, so it's left out.
    audible = rms[rms > 1e-6]
    floor = float(np.percentile(audible, 20)) if audible.size else 0.0
    threshold = max(floor * 4.0, 2e-4)
    voiced = rms > threshold

    spans: list[Span] = []
    start = None
    for i, v in enumerate(voiced):
        if v and start is None:
            start = i
        elif not v and start is not None:
            spans.append((start * FRAME_S, i * FRAME_S))
            start = None
    if start is not None:
        spans.append((start * FRAME_S, n * FRAME_S))
    return merge_gaps(spans, MIN_GAP_S)


def merge_gaps(spans: list[Span], min_gap: float) -> list[Span]:
    merged: list[Span] = []
    for s, e in spans:
        if merged and s - merged[-1][1] < min_gap:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return merged


def chunk_bounds(duration: float, spans: list[Span]) -> list[Span]:
    """Cut the recording at pauses into sentence-sized pieces.

    BuzzASR was trained on short clips and drops sentences when given ~30 s at once,
    so a piece ends at a pause of PAUSE_SPLIT_S once it is MIN_PIECE_S long, at any
    pause once it is SOFT_MAX_S long, and is never longer than MAX_CHUNK_S.
    """
    if not spans:
        return [(0.0, duration)] if duration > 0 else []
    groups: list[list[float]] = []
    for s, e in spans:
        while e - s > MAX_CHUNK_S:  # continuous sound with no pause at all
            groups.append([s, s + MAX_CHUNK_S])
            s += MAX_CHUNK_S
        if groups:
            ps, pe = groups[-1]
            length, gap = pe - ps, s - pe
            split = (
                (gap >= PAUSE_SPLIT_S and length >= MIN_PIECE_S)
                or length >= SOFT_MAX_S
                or e - ps > MAX_CHUNK_S
            )
            if not split:
                groups[-1][1] = e
                continue
        groups.append([s, e])

    # Pad each piece a little so word edges aren't clipped, without overlapping neighbours.
    pieces: list[Span] = []
    for k, (s, e) in enumerate(groups):
        lo = max(s - EDGE_PAD_S, pieces[-1][1] if pieces else 0.0)
        hi = min(e + EDGE_PAD_S, groups[k + 1][0] if k + 1 < len(groups) else duration, duration)
        pieces.append((round(lo, 3), round(hi, 3)))
    return pieces


def clip_spans(spans: list[Span], lo: float, hi: float) -> list[Span]:
    return [(max(s, lo), min(e, hi)) for s, e in spans if e > lo and s < hi]


def spread_words(tokens: list[str], spans: list[Span]) -> list[Word]:
    """Place tokens over the voiced spans, each taking time in proportion to its length."""
    tokens = [t for t in tokens if t.strip()]
    if not tokens or not spans:
        return []
    total = sum(e - s for s, e in spans)
    weights = [len(t) + 1 for t in tokens]  # +1 so short words still get some time
    scale = total / sum(weights)

    # Where each span begins in "speech time" (silences removed).
    offsets, acc = [], 0.0
    for s, e in spans:
        offsets.append(acc)
        acc += e - s

    def span_of(pos: float) -> int:
        for i in range(len(spans) - 1, -1, -1):
            if pos >= offsets[i]:
                return i
        return 0

    words: list[Word] = []
    pos = 0.0
    for token, w in zip(tokens, weights):
        end_pos = pos + w * scale
        i, j = span_of(pos), span_of(min(end_pos, total) - 1e-9)
        if i != j:
            # The word would cross a silence: keep it on the side that holds more of it.
            before = offsets[i] + (spans[i][1] - spans[i][0]) - pos
            i = i if before >= end_pos - offsets[j] else j
        s, e = spans[i]
        start = min(max(s + (pos - offsets[i]), s), e)
        end = min(max(s + (end_pos - offsets[i]), start), e)
        words.append({"word": token, "start": round(start, 2), "end": round(end, 2)})
        pos = end_pos
    return words

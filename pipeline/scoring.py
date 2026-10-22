"""Overall = 0.35 C + 0.30 D + 0.25 S + 0.10 T, computed in code.

A category with no data is None, not zero, and the overall score is reweighted over
the categories that exist. All thresholds live in THRESHOLDS so we can tune them on our clips.
"""

from statistics import mean

WEIGHTS = {"content": 0.35, "delivery": 0.30, "slide_alignment": 0.25, "timing": 0.10}

THRESHOLDS = {
    # (full-score range) and the point where the score reaches zero
    "pace_wpm": {"full": (120, 150), "zero": (80, 200)},
    "fillers_per_100": {"full": 1.0, "zero": 6.0},
    "long_pauses_per_min": {"full": 1.0, "zero": 6.0},
    "pitch_range_st": {"full": 6.0, "zero": 3.0},
    "end_volume_drop_db": {"full": 3.0, "zero": 10.0},
    "timing_off": {"full": 0.10, "zero": 0.50},
    "mismatch_penalty": 5,
}


def _lerp_down(value: float, full: float, zero: float) -> float:
    """100 at or below `full`, 0 at or above `zero` (works for either direction)."""
    if full < zero:
        if value <= full:
            return 100.0
        if value >= zero:
            return 0.0
        return 100.0 * (zero - value) / (zero - full)
    # higher is better (pitch range)
    if value >= full:
        return 100.0
    if value <= zero:
        return 0.0
    return 100.0 * (value - zero) / (full - zero)


def delivery_parts(metrics: dict, wording: dict) -> dict:
    t = THRESHOLDS
    parts: dict[str, float | None] = {}

    wpm = metrics.get("wpm")
    if wpm is None:
        parts["pace"] = None
    else:
        lo, hi = t["pace_wpm"]["full"]
        zlo, zhi = t["pace_wpm"]["zero"]
        parts["pace"] = _lerp_down(wpm, hi, zhi) if wpm > hi else _lerp_down(wpm, lo, zlo)

    f = wording.get("fillers_per_100")
    parts["fillers"] = None if f is None else _lerp_down(f, t["fillers_per_100"]["full"], t["fillers_per_100"]["zero"])

    p = metrics.get("long_pauses_per_min")
    parts["pauses"] = None if p is None else _lerp_down(p, t["long_pauses_per_min"]["full"], t["long_pauses_per_min"]["zero"])

    r = metrics.get("pitch_range_st")
    parts["pitch_range"] = None if r is None else _lerp_down(r, t["pitch_range_st"]["full"], t["pitch_range_st"]["zero"])

    v = metrics.get("end_volume_drop_db")
    parts["volume_end"] = None if v is None else _lerp_down(max(v, 0), t["end_volume_drop_db"]["full"], t["end_volume_drop_db"]["zero"])

    return {k: (round(x) if x is not None else None) for k, x in parts.items()}


def compute(
    content_scores: list[dict],
    metrics: dict,
    wording: dict,
    coverage: float | None,
    confirmed_mismatches: int,
    planned_s: float | None,
) -> dict:
    content = round(mean(c["score"] for c in content_scores)) if content_scores else None

    parts = delivery_parts(metrics, wording)
    available = [v for v in parts.values() if v is not None]
    delivery = round(mean(available)) if available else None

    slide_alignment = None
    if coverage is not None:
        slide_alignment = max(0, round(coverage * 100 - THRESHOLDS["mismatch_penalty"] * confirmed_mismatches))

    timing = None
    duration = metrics.get("duration_s")
    if planned_s and duration:
        off = abs(duration - planned_s) / planned_s
        timing = round(_lerp_down(off, THRESHOLDS["timing_off"]["full"], THRESHOLDS["timing_off"]["zero"]))

    cats = {"content": content, "delivery": delivery, "slide_alignment": slide_alignment, "timing": timing}
    used = {k: v for k, v in cats.items() if v is not None}
    overall = None
    if used:
        wsum = sum(WEIGHTS[k] for k in used)
        overall = round(sum(WEIGHTS[k] * v for k, v in used.items()) / wsum)

    return {**cats, "overall": overall, "categories_used": len(used), "delivery_parts": parts}

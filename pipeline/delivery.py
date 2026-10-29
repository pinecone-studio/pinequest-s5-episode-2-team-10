"""Delivery checks from word timings and loudness: rushed stretches, speeding up at the end,
long silences, bursts of fillers, and sentences that fade out.

Rules only, no model. Each finding becomes a "delivery" recommendation with the time it happened,
so the page can show and play the sentence said there.

Word times are estimates (see word_timing): pauses are real silences, but times inside a stretch
of speech are spread evenly, so pace is measured over 30 s windows, never per word. Loudness
depends on the microphone, so it is only compared within one recording. The limits are first
guesses for Mongolian pitches; tune them on real recordings. Pitch and intonation are left out.
"""

import statistics
from pathlib import Path

from . import loudness
from .segments import Sentence, Word

MIN_WORDS = 30  # fewer words than this: too little to judge delivery

PACE_WINDOW_S = 30.0
PACE_STEP_S = 10.0
RUSH_RATIO = 1.3  # a window this much faster than the speaker's usual pace…
RUSH_MIN_GAIN_WPM = 25  # …and at least this many words/min faster counts as rushed
END_SHARE = 0.25  # "the end" is the last quarter of the speaking time
END_SPEEDUP_RATIO = 1.25
MIN_END_CHECK_S = 40.0  # short practice pitches (40–60 s) can rush their ending too

LONG_PAUSE_S = 3.0  # a silence this long mid-pitch usually means a lost thread

FILLER_WINDOW_S = 20.0
FILLER_BURST = 4  # this many confirmed fillers within FILLER_WINDOW_S

TRAIL_MIN_WORDS = 5
TRAIL_END_WORDS = 2
# Both last words this much quieter than the rest of the sentence. Mongolian sentences end in
# verb endings and particles that are naturally softer, so one quiet last word isn't a fade.
TRAIL_DROP_DB = 6.0
TRAIL_MIN_SENTENCES = 2
TRAIL_MIN_SHARE = 0.25


def clock(seconds: float) -> str:
    s = max(0, round(seconds))
    return f"{s // 60}:{s % 60:02d}"


def _rec(problem: str, action: str, start_s: float, impact: str = "medium") -> dict:
    # "source": measured by code, not written by the model (the page lists these as things to work on).
    return {"area": "delivery", "problem": problem, "start_s": round(start_s, 2), "slide": None, "why": "",
            "action": action, "example_sentence": "", "impact": impact, "source": "measured"}


def _pace(words: list[Word], start: float, end: float) -> float:
    n = sum(1 for w in words if start <= w["start"] < end)
    return n / (end - start) * 60 if end > start else 0.0


def check(words: list[Word], sentences: list[Sentence], levels: list[float | None],
          filler_occurrences: list[dict]) -> tuple[list[dict], dict]:
    """Delivery recommendations, most important first, plus the numbers behind them.

    `levels` is each word's loudness (loudness.word_levels), None where unknown.
    `filler_occurrences` are the fillers confirmed in context: [{sentence_id, word}].
    """
    facts = {"usual_wpm": None, "long_pauses": 0, "filler_bursts": 0, "fading_sentences": 0, "checked_sentences": 0}
    if len(words) < MIN_WORDS:
        return [], facts
    recs: list[dict] = []
    first, last = words[0]["start"], words[-1]["end"]

    # ---- Pace ---------------------------------------------------------------------------------
    windows = []
    start = first
    while start + PACE_WINDOW_S <= last + 0.001:
        windows.append((start, start + PACE_WINDOW_S, _pace(words, start, start + PACE_WINDOW_S)))
        start += PACE_STEP_S
    if len(windows) >= 2:
        usual = statistics.median(w[2] for w in windows)
        facts["usual_wpm"] = round(usual)
        end_from = last - (last - first) * END_SHARE
        end_reported = False
        if last - first >= MIN_END_CHECK_S:
            before, after = _pace(words, first, end_from), _pace(words, end_from, last + 0.001)
            if before > 0 and after >= before * END_SPEEDUP_RATIO:
                end_reported = True
                recs.append(_rec(
                    f"Төгсгөлдөө яарсан: {clock(end_from)}-с хойш минутад {after:.0f} үг, өмнө нь {before:.0f}.",
                    "Төгсгөлөө удаан, тодорхой хэл: үзэгчид хамгийн сүүлд сонссоноо санадаг.",
                    next(w["start"] for w in words if w["start"] >= end_from), "high",
                ))
        lo, hi, wpm = max(windows, key=lambda w: w[2])
        in_end = lo >= end_from - PACE_STEP_S
        if wpm >= usual * RUSH_RATIO and wpm - usual >= RUSH_MIN_GAIN_WPM and not (end_reported and in_end):
            recs.append(_rec(
                f"Яаран ярьсан хэсэг: {clock(lo)}–{clock(hi)} минутад {wpm:.0f} үг (таны ердийн хурд {usual:.0f}).",
                "Энэ хэсгийг удаан давт; гол өгүүлбэр бүрийн дараа богино завсарла.",
                next(w["start"] for w in words if w["start"] >= lo),
            ))

    # ---- Long pauses --------------------------------------------------------------------------
    pauses = [(b["start"] - a["end"], a["end"], b["start"]) for a, b in zip(words, words[1:]) if b["start"] - a["end"] >= LONG_PAUSE_S]
    facts["long_pauses"] = len(pauses)
    if pauses:
        times = ", ".join(f"{clock(at)} ({gap:.1f} с)" for gap, at, _ in pauses[:3])
        longest = max(pauses)
        recs.append(_rec(
            f"{LONG_PAUSE_S:.0f} секундээс урт завсарлага: {times}.",
            "Төлөвлөсөн бол зүгээр. Бодол тасарсан бол дараагийн өгүүлбэрийг цээжил.",
            longest[2],
        ))

    # ---- Bursts of confirmed fillers -------------------------------------------------------------
    at = sorted(sentences[o["sentence_id"]]["start"] for o in filler_occurrences if 0 <= o["sentence_id"] < len(sentences))
    bursts = []
    i = 0
    while i < len(at):
        j = i
        while j + 1 < len(at) and at[j + 1] - at[i] <= FILLER_WINDOW_S:
            j += 1
        if j - i + 1 >= FILLER_BURST:
            bursts.append((at[i], at[j], j - i + 1))
            i = j + 1
        else:
            i += 1
    facts["filler_bursts"] = len(bursts)
    if bursts:
        where = ", ".join(f"{clock(a)}–{clock(b)} ({n})" for a, b, n in bursts[:2])
        worst = max(bursts, key=lambda b: b[2])
        recs.append(_rec(
            f"Дүүргэгч үг бөөгнөрсөн хэсэг: {where}.",
            "Энэ хэсгийг дахин дасгалла: ихэвчлэн сайн бэлдээгүй хэсэг байдаг.",
            worst[0],
        ))

    # ---- Fading at the ends of sentences --------------------------------------------------------
    level_at = {(w["start"], w["end"]): lv for w, lv in zip(words, levels)}
    checked, fading = 0, []
    for s in sentences:
        ws = [w for w in words if s["start"] <= w["start"] and w["end"] <= s["end"]]
        lv = [level_at.get((w["start"], w["end"])) for w in ws]
        if len(ws) < TRAIL_MIN_WORDS or any(v is None for v in lv):
            continue
        checked += 1
        body = statistics.median(lv[:-TRAIL_END_WORDS])
        tail = max(lv[-TRAIL_END_WORDS:])
        if body - tail >= TRAIL_DROP_DB:
            fading.append((body - tail, s))
    facts["checked_sentences"], facts["fading_sentences"] = checked, len(fading)
    if len(fading) >= TRAIL_MIN_SENTENCES and len(fading) >= checked * TRAIL_MIN_SHARE:
        drop, worst_s = max(fading, key=lambda f: f[0])
        recs.append(_rec(
            f"{checked} өгүүлбэрээс {len(fading)}-д нь төгсгөлд дуу суларсан (хамгийн их нь {clock(worst_s['start'])} орчим, {drop:.0f} дБ).",
            "Өгүүлбэрийн сүүлийн үг хүртэл ижил чанга хэл.",
            worst_s["start"],
        ))

    return recs, facts


def word_levels(wav: Path, words: list[Word]) -> list[float | None]:
    """Loudness of each word from the 16 kHz mono WAV; all None if it can't be read."""
    import wave

    import numpy as np

    try:
        with wave.open(str(wav), "rb") as w:
            if w.getsampwidth() != 2 or w.getnchannels() != 1:
                return [None] * len(words)
            sr = w.getframerate()
            samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    except (OSError, wave.Error):
        return [None] * len(words)
    return loudness.word_levels(samples, sr, words)

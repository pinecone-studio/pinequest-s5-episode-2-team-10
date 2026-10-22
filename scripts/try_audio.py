"""Try the speech and audio analysis on one recording, without the server or the UI.

Three levels, each adding to the one before:
  python -m scripts.try_audio pitch.m4a                          # code only: pauses, speaking time, pitch, volume
  python -m scripts.try_audio pitch.m4a --asr duudlaga           # + speech recognition (Duudlaga API, needs DUUDLAGA_API_KEY)
  python -m scripts.try_audio pitch.m4a --asr whisper            # + speech recognition (BuzzASR on a GPU)
  python -m scripts.try_audio pitch.m4a --asr whisper --backend gemma4-base   # + AI analysis: the whole pipeline

Duudlaga returns text only, so word and sentence times are spread evenly (estimates) and pauses
can only be seen in the code-only level. BuzzASR (Whisper large-v3) gives real word timings but needs a GPU (use Kaggle). To check the plumbing
on a laptop, a small model works: --asr-model openai/whisper-tiny (poor Mongolian, but fast).
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

LONG_PAUSE_S = 2.0  # same threshold as pipeline/metrics.py
MIN_PAUSE_S = 0.3  # shorter gaps are normal between words
SILENCE_BELOW_PEAK_DB = 25  # quieter than this, relative to the loudest part, counts as silence


def fmt(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:04.1f}"


def find_pauses(wav: Path) -> dict:
    """Silence and speech from loudness alone (no model)."""
    import numpy as np
    import parselmouth

    intensity = parselmouth.Sound(str(wav)).to_intensity(time_step=0.01)
    db = intensity.values[0]
    times = intensity.xs()
    speaking = db > db.max() - SILENCE_BELOW_PEAK_DB

    # Runs of silence between the first and last moment of speech.
    idx = np.flatnonzero(speaking)
    if len(idx) == 0:
        return {"pauses": [], "speech_start": None, "speech_end": None, "speaking_s": 0.0}
    start, end = times[idx[0]], times[idx[-1]]
    pauses, run_start = [], None
    for t, s in zip(times, speaking):
        if t < start or t > end:
            continue
        if not s and run_start is None:
            run_start = t
        elif s and run_start is not None:
            if t - run_start >= MIN_PAUSE_S:
                pauses.append((round(run_start, 2), round(t, 2)))
            run_start = None
    paused = sum(b - a for a, b in pauses)
    return {"pauses": pauses, "speech_start": round(start, 2), "speech_end": round(end, 2),
            "speaking_s": round(end - start - paused, 2)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", type=Path, help="WAV, MP3, M4A, WebM or OGG")
    ap.add_argument("--asr", choices=["none", "duudlaga", "whisper", "stub"], default="none")
    ap.add_argument("--asr-model", help="Hugging Face model id (default BuzzASR/mongolian)")
    ap.add_argument("--backend", help="also run the AI analysis: rules | claude | gemma4-base | gemma4-ft | ollama:<model>")
    ap.add_argument("--slides", type=Path, help="PDF or PPTX, used with --backend")
    ap.add_argument("--script", type=Path, help="planned script, used with --backend")
    ap.add_argument("--planned-s", type=int, default=180)
    ap.add_argument("--pitch-type", choices=["startup", "academic"], default="startup")
    ap.add_argument("--json", type=Path, help="write the results here")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    if args.backend and args.asr == "none":
        ap.error("--backend needs speech recognition: add --asr duudlaga or --asr whisper (or --asr stub to test the plumbing)")
    # Pipeline settings are read from the environment when the modules load.
    os.environ["PITCH_ASR"] = args.asr if args.asr != "none" else "stub"
    if args.asr_model:
        os.environ["PITCH_ASR_MODEL"] = args.asr_model
    os.environ.setdefault("PITCH_EMBEDDINGS", "none")

    from pipeline import asr, audio, metrics, segments, text_checks

    out: dict = {}
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "audio.wav"
        try:
            duration = audio.to_wav16k(args.audio, wav)
        except audio.AudioError as e:
            print(e)
            return 1
        print(f"{args.audio.name}: {fmt(duration)} long")

        # ---- Level 1: code only -------------------------------------------
        p = find_pauses(wav)
        voice = metrics.measure(wav, [], duration)
        long_pauses = [(a, b) for a, b in p["pauses"] if b - a >= LONG_PAUSE_S]
        print("\nAUDIO (code only, no model)")
        if p["speech_start"] is None:
            print("  No speech found.")
        else:
            print(f"  speech from {fmt(p['speech_start'])} to {fmt(p['speech_end'])}, "
                  f"speaking {p['speaking_s']} s of {duration:.1f} s")
            print(f"  pauses over {MIN_PAUSE_S} s: {len(p['pauses'])}, long pauses (≥ {LONG_PAUSE_S:.0f} s): {len(long_pauses)}")
            for a, b in p["pauses"]:
                print(f"    {fmt(a)} – {fmt(b)}  ({b - a:.1f} s){'  long' if b - a >= LONG_PAUSE_S else ''}")
        print(f"  pitch range: {voice['pitch_range_st']} semitones (10th to 90th percentile)")
        print(f"  volume drop at the end: {voice['end_volume_drop_db']} dB")
        out["audio"] = {**p, "duration_s": duration, "pitch_range_st": voice["pitch_range_st"],
                        "end_volume_drop_db": voice["end_volume_drop_db"]}

        # ---- Level 2: speech recognition ----------------------------------
        if args.asr != "none":
            print(f"\nSPEECH RECOGNITION ({args.asr}{', ' + args.asr_model if args.asr_model else ''})")
            try:
                words, used = asr.transcribe(wav)
            except asr.AsrError as e:
                print(f"  {e}")
                return 1
            asr.unload()
            if used == "stub":
                print("  (stub: sample sentences spread over the audio, not your speech)")
            elif used == "duudlaga":
                print("  (Duudlaga returns text only: word times are spread evenly, so pauses and timestamps are estimates)")
            sentences = segments.to_sentences(words)
            measured = metrics.measure(wav, words, duration)
            wording = text_checks.check(sentences)
            print(f"  {len(words)} words, {len(sentences)} sentences, pace {measured['wpm']} words/min, "
                  f"long pauses between words: {measured['long_pauses']}")
            print(f"  fillers from the word list: {wording['filler_total']} {wording['fillers'] or ''}")
            print("  transcript:")
            for s in sentences:
                print(f"    {fmt(s['start'])}  {s['text']}")
            out["asr"] = {"words": words, "sentences": sentences, "metrics": measured, "wording": wording}

        # ---- Level 3: the whole pipeline ------------------------------------
        if args.backend:
            from pipeline import feedback, run, slides as slide_tools
            from scripts.try_analysis import print_rest

            deck = slide_tools.extract(args.slides) if args.slides else []
            session = {"title": args.audio.stem, "goal": "", "audience": "", "planned_s": args.planned_s,
                       "pitch_type": args.pitch_type,
                       "script": args.script.read_text(encoding="utf-8") if args.script else ""}
            print(f"\nAI ANALYSIS ({args.backend}); runs speech recognition again inside the pipeline")
            try:
                result = run.analyze(wav, duration, session, deck, args.backend,
                                     on_stage=lambda st: print(f"  … {st}"))
            except (feedback.FeedbackError, asr.AsrError, ValueError) as e:
                print(f"  failed: {e}")
                return 1
            fill = result["feedback"]["fillers"]
            print(f"\nFILLER WORDS ({fill['method']}): {fill['total']} verified, model reported "
                  f"{fill.get('model_reported')}, {fill['per_100']} per 100 words")
            for w in fill["words"]:
                print(f"  “{w['word']}” ×{w['count']} at {', '.join(fmt(o['start_s']) for o in w['occurrences'])}")
            print_rest({"feedback": result["feedback"], "scores": result["scores"]}, fillers_only_delivery=False)
            for n in result["notes"]:
                print(f"  note: {n}")
            out["analysis"] = {k: result[k] for k in ("scores", "metrics", "feedback", "notes")}

    if args.json:
        args.json.write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        print(f"\nFull results written to {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

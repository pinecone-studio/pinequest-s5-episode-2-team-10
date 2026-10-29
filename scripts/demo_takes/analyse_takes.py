"""Runs the real analysis (pipeline.run.analyze, Gemma) on take1..3.wav for the Агаар demo pitch and
saves what the takes card needs to takes.json next to this file. Run from the repository root."""
import json
import sys
import time
from pathlib import Path

from pipeline import run, slides
from pipeline.audio import to_wav16k

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).parent
ROOT = Path.cwd()
POINTS = ["Цэцэрлэгүүд агаарын чанараа хэмждэггүй", "Мэдрэгч ба апп эцэг эхэд агаарын чанарыг харуулна",
          "Туршилтад PM2.5 40%-иар буурсан", "120 сая төгрөгийн хөрөнгө оруулалт хэрэгтэй"]
SESSION = {"title": "Агаар", "goal": "", "audience": "шүүгчид", "planned_s": 60, "pitch_type": "startup", "script": "",
           "idea": "Цэцэрлэгийн өрөөн доторх агаарын чанарыг хямд мэдрэгчээр хянаж, хүүхдүүдийг утаанаас хамгаална.",
           "key_points": POINTS}
deck = [dict(s) for s in slides.extract(ROOT / "web/public/defaults/demo/agaar.pdf")]

takes = []
ONLY = set(sys.argv[2:])  # take names to (re)analyse; the others keep their saved result
old = {t["attempt"]["id"]: t for t in json.loads((HERE / "takes.json").read_text(encoding="utf-8"))} if (HERE / "takes.json").exists() else {}
for i, name in enumerate(["take1", "take2", "take3"]):
    if ONLY and name not in ONLY:
        takes.append(old[f"example-agaar-{i + 1}"])
        continue
    wav = HERE / f"{name}.16k.wav"
    duration = to_wav16k(HERE / f"{name}.wav", wav)
    started = time.monotonic()
    r = run.analyze(wav, duration, SESSION, deck, sys.argv[1] if len(sys.argv) > 1 else "gemma4-base")
    fb = r["feedback"]
    mp = fb.get("main_points") or {}
    print(f"\n=== {name}: {time.monotonic() - started:.0f} s, model {r['feedback_backend']}, fallbacks {r['fallbacks']}")
    for p in mp.get("points", []):
        print(f"  point {p['status']:<8} verified={p['verified']} {p['text']}")
    m = r["metrics"]
    print(f"  fillers/100 {m.get('fillers_per_100')}  wpm {m.get('wpm')}  long pauses/min {m.get('long_pauses_per_min')}  volume drop {m.get('end_volume_drop_db')}")
    print("  fillers:", [(w["word"], w["count"]) for w in (fb.get("fillers") or {}).get("words", [])])
    for rec in fb["recommendations"]:
        print(f"  [{rec['area']}] {rec['problem']}")
    takes.append({
        "attempt": {"id": f"example-agaar-{i + 1}", "created_at": f"2026-10-2{6 + i}T10:00:00+00:00",
                    "audio_filename": f"example-take-{i + 1}.wav", "duration_s": round(duration, 2)},
        "report": {
            "metrics": m,
            "feedback": {
                "main_points": {"points": [{k: p[k] for k in ("point", "text", "status", "verified")} for p in mp.get("points", [])]},
                "number_checks": fb.get("number_checks", []),
                "fillers": {"words": [{"word": w["word"], "count": w["count"]} for w in (fb.get("fillers") or {}).get("words", [])]},
                "recommendations": [{k: rec[k] for k in ("area", "problem", "action", "source") if k in rec} for rec in fb["recommendations"]],
            },
        },
    })
(HERE / "takes.json").write_text(json.dumps(takes, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nsaved", HERE / "takes.json")

"""Training data for a faster feedback model: Gemma 4 E4B (teacher) answers, Gemma 4 E2B learns them.

Each example is exactly what the app sends (pipeline.feedback: system prompt + analysis input),
with the teacher's checked JSON answer, written compactly (fewer tokens to generate = faster).

    # real transcripts (preferred): one .txt per pitch
    python -m training.speed.make_data --transcripts data/transcripts --out data/speed
    # or synthetic Mongolian pitches written by the teacher, when real ones are few
    python -m training.speed.make_data --synthetic 300 --out data/speed
    # check the inputs without a model
    python -m training.speed.make_data --synthetic 3 --dry-run

Needs Ollama with the teacher model (default gemma4:e4b) at OLLAMA_URL. Use transcripts you have
consent for; data/ is not committed.
"""

import argparse
import json
import random
import sys
import time
from pathlib import Path

import httpx

from pipeline import alignment, config, feedback, text_checks
from scripts.try_analysis import to_sentences

TOPICS = [
    "оюутнуудад илтгэлийн дасгал хийх апп", "хотын агаарын чанарыг хэмжих мэдрэгч", "малчдад зориулсан онлайн зах",
    "хүүхдэд монголоор уншиж сургах AI", "алслагдсан сумын эмчийн видео зөвлөгөө", "автобусны хүлээлтийн хугацааг харуулах апп",
    "хог дахин боловсруулах цэг олох газрын зураг", "жижиг дэлгүүрт зориулсан бараа бүртгэлийн систем",
    "ахмад настнуудад эм уухыг сануулах төхөөрөмж", "оюутны дотуур байрны түрээсийн платформ",
    "ноолуурын бүтээгдэхүүний гарал үүслийг шалгах QR", "сургуулийн хоолны захиалгын апп", "хөдөөгийн сургуульд онлайн хичээл",
    "гэр хорооллын дулаалгын шийдэл", "аялал жуулчлалын нүүдэлчин гэр буудал захиалга", "хөгжлийн бэрхшээлтэй хүмүүст дохионы хэлний орчуулга",
]
STYLES = [
    "Энгийн, цэгцтэй ярь.",
    "Олон удаа 'ээ', 'аан', 'нөгөө' гэж бөглөж ярь.",
    "Яаран, 'тэгээд' гэж олон өгүүлбэрийг холбож ярь.",
    "Төгсгөлд нь юу хүсч байгаагаа хэлэхгүй орхи.",
    "Асуудлыг тодорхой хэлэлгүй шууд шийдлээс эхэл.",
    "Тоо, статистик олон дурд.",
]
AUDIENCES = ["шүүгчид", "хөрөнгө оруулагчид", "багш нар", "оюутнууд"]


def ollama(path: str, body: dict, timeout: float = 600) -> dict:
    headers = {"Authorization": f"Bearer {config.OLLAMA_TOKEN}"} if config.OLLAMA_TOKEN else None
    r = httpx.post(f"{config.OLLAMA_URL}{path}", json=body, headers=headers, timeout=timeout)
    r.raise_for_status()
    return r.json()


def synthetic_pitch(teacher: str, rng: random.Random) -> tuple[str, dict]:
    topic, style, audience = rng.choice(TOPICS), rng.choice(STYLES), rng.choice(AUDIENCES)
    sentences = rng.randint(6, 14)
    prompt = (
        f"{audience}-д зориулсан, {topic}-ийн тухай {sentences} өгүүлбэртэй илтгэлийг яг хүн ярьж байгаа шиг "
        f"монгол кирилл үсгээр бич. {style} Зөвхөн ярианы текстийг бич, гарчиг, тайлбар бүү бич."
    )
    reply = ollama("/api/generate", {"model": teacher, "prompt": prompt, "stream": False, "think": False,
                                     "options": {"temperature": 0.9, "num_predict": 700}})
    session = {"title": topic, "goal": "", "audience": audience, "planned_s": rng.choice([60, 120, 180]),
               "pitch_type": "startup"}
    return reply.get("response", "").strip(), session


def build(text: str, session: dict) -> dict | None:
    sentences = to_sentences(text)
    if len(sentences) < 3:
        return None
    wording = text_checks.check(sentences)
    metrics = {"duration_s": sentences[-1]["end"], "wpm": None, "long_pauses_per_min": None,
               "pitch_range_st": None, "end_volume_drop_db": None}
    return feedback.build_input(session, sentences, metrics, wording, [], alignment.align(sentences, []))


def teach(teacher: str, data: dict) -> tuple[dict | None, dict]:
    """The teacher's answer if it passes the schema, plus its timing numbers."""
    started = time.monotonic()
    reply = ollama("/api/chat", {
        "model": teacher, "stream": False, "format": feedback.SCHEMA, "think": False,
        "options": {"temperature": 0, "num_ctx": 8192},
        "messages": [{"role": "system", "content": feedback.PROMPT},
                     {"role": "user", "content": json.dumps(data, ensure_ascii=False)}],
    })
    stats = {"seconds": round(time.monotonic() - started, 2), "eval_count": reply.get("eval_count"),
             "prompt_eval_count": reply.get("prompt_eval_count")}
    try:
        answer = json.loads(reply.get("message", {}).get("content", ""))
        feedback.Feedback.model_validate(answer)
        return answer, stats
    except Exception:
        return None, stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--transcripts", type=Path, help="folder of .txt transcripts (real pitches)")
    ap.add_argument("--synthetic", type=int, default=0, help="also write this many synthetic pitches")
    ap.add_argument("--teacher", default=config.OLLAMA_MODEL_BASE)
    ap.add_argument("--out", type=Path, default=Path("data/speed"))
    ap.add_argument("--test-share", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--dry-run", action="store_true", help="build inputs only, no model calls")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)
    rng = random.Random(args.seed)

    pitches: list[tuple[str, dict]] = []
    if args.transcripts:
        for f in sorted(args.transcripts.glob("*.txt")):
            pitches.append((f.read_text(encoding="utf-8"), {"title": f.stem, "goal": "", "audience": "шүүгчид",
                                                            "planned_s": 120, "pitch_type": "startup"}))
    for i in range(args.synthetic):
        if args.dry_run:
            pitches.append(("Сайн байна уу, ээ, бид шинэ апп хийсэн. Тэгээд оюутнууд их ашиглана. "
                            "Үүнд 3 сая төгрөг хэрэгтэй. Баярлалаа.", {"title": "dry run", "goal": "", "audience": "шүүгчид",
                                                                       "planned_s": 60, "pitch_type": "startup"}))
        else:
            text, session = synthetic_pitch(args.teacher, rng)
            pitches.append((text, session))
            print(f"synthetic {i + 1}/{args.synthetic}: {len(text.split())} words")

    args.out.mkdir(parents=True, exist_ok=True)
    rows, kept, dropped = [], 0, 0
    for n, (text, session) in enumerate(pitches, 1):
        data = build(text, session)
        if data is None:
            dropped += 1
            continue
        if args.dry_run:
            answer, stats = {"note": "dry run, no teacher answer"}, {}
        else:
            answer, stats = teach(args.teacher, data)
            if answer is None:
                dropped += 1
                print(f"{n}/{len(pitches)}: teacher answer failed the schema, skipped")
                continue
            print(f"{n}/{len(pitches)}: {stats['eval_count']} answer tokens in {stats['seconds']} s")
        kept += 1
        rows.append({
            "messages": [
                {"role": "system", "content": feedback.PROMPT},
                {"role": "user", "content": json.dumps(data, ensure_ascii=False)},
                # Compact JSON: the same answer in fewer tokens.
                {"role": "assistant", "content": json.dumps(answer, ensure_ascii=False, separators=(",", ":"))},
            ],
            "teacher": {"model": args.teacher, **stats, "prompt_version": feedback.PROMPT_VERSION},
        })

    rng.shuffle(rows)
    n_test = max(1, int(len(rows) * args.test_share)) if len(rows) > 1 else 0
    for name, part in (("test", rows[:n_test]), ("train", rows[n_test:])):
        with (args.out / f"{name}.jsonl").open("w", encoding="utf-8") as f:
            for row in part:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"\nkept {kept}, dropped {dropped} -> {args.out}/train.jsonl ({len(rows) - n_test}), test.jsonl ({n_test})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Compare Mongolian text-to-speech engines by ear: the same coaching sentences, side by side.

    set -a; . web/.env.local; set +a              # the keys live there (git-ignored)
    python -m scripts.compare_tts                 # Azure (AZURE_SPEECH_KEY/REGION) + ElevenLabs (ELEVENLABS_API_KEY)
    python -m scripts.compare_tts --open          # also open the comparison page in the browser
    python -m scripts.compare_tts --reuse         # rebuild the page from saved audio (no API characters used)

Writes data/tts-compare/index.html (data/ is not committed) with one row per sentence and one
audio player per engine, plus how long each took. Numbers are left as digits, as the app sends them.

ElevenLabs v4 Turbo is sent language_code "mn"; eleven_v3 reads Mongolian too but rejects the code,
so it gets none. Every run uses characters from your plans (Azure's free tier covers 500k a month).
"""

import argparse
import html
import os
import sys
import time
import webbrowser
from pathlib import Path

import httpx

SENTENCES = [
    "Илтгэлийн гол санаагаа эхний гучин секундэд хэлээрэй.",
    "Та минутанд 160 үг хэлсэн нь хурдан байна. Гол тооны дараа нэг секунд завсарлаарай.",
    "Слайд дээр 25% гэж бичсэн ч та гучин хувь гэж хэлсэн.",
    "Бид 2024 онд 150 оюутантай туршилт хийсэн бөгөөд үр дүн маш сайн байлаа.",
    "Төгсгөлд нь шүүгчдээс юу хүсч байгаагаа тодорхой хэлээрэй.",
]
ELEVEN_MODELS = ["eleven_v4_turbo", "eleven_v3"]
ELEVEN_VOICE = os.environ.get("PITCH_ELEVENLABS_VOICE", "JBFqnCBsd6RMkjVDRZzb")
OUT = Path("data/tts-compare")


def azure(text: str) -> bytes:
    voice = os.environ.get("PITCH_TTS_VOICE", "mn-MN-YesuiNeural")
    ssml = f'<speak version="1.0" xml:lang="mn-MN"><voice name="{html.escape(voice)}">{html.escape(text)}</voice></speak>'
    r = httpx.post(
        f"https://{os.environ['AZURE_SPEECH_REGION']}.tts.speech.microsoft.com/cognitiveservices/v1",
        headers={
            "Ocp-Apim-Subscription-Key": os.environ["AZURE_SPEECH_KEY"],
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
            "User-Agent": "saylo",
        },
        content=ssml.encode(),
        timeout=60,
    )
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    return r.content


def elevenlabs(model: str):
    key = os.environ["ELEVENLABS_API_KEY"]

    def run(text: str) -> bytes:
        r = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVEN_VOICE}",
            params={"output_format": "mp3_44100_64"},
            headers={"xi-api-key": key},
            json={"text": text, "model_id": model, **({} if model.startswith("eleven_v3") else {"language_code": "mn"})},
            timeout=120,
        )
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        return r.content

    return run


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--open", action="store_true", help="open the comparison page")
    ap.add_argument("--no-elevenlabs", action="store_true", help="skip ElevenLabs (no characters used)")
    ap.add_argument("--no-azure", action="store_true", help="skip Azure")
    ap.add_argument("--reuse", action="store_true", help="use audio already saved in data/tts-compare")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    engines: list[tuple[str, str, object]] = []
    if os.environ.get("AZURE_SPEECH_KEY") and os.environ.get("AZURE_SPEECH_REGION") and not args.no_azure:
        engines.append(("azure", "Azure (mn-MN neural)", azure))
    else:
        print("Azure skipped (no AZURE_SPEECH_KEY/AZURE_SPEECH_REGION, or --no-azure).")
    if os.environ.get("ELEVENLABS_API_KEY") and not args.no_elevenlabs:
        engines += [(m, f"ElevenLabs {m}", elevenlabs(m)) for m in ELEVEN_MODELS]
    else:
        print("ElevenLabs skipped (no ELEVENLABS_API_KEY, or --no-elevenlabs).")
    if not engines:
        print("Nothing to compare: set the Azure and/or ElevenLabs keys.")
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    rows, totals, chars = [], {e[0]: 0.0 for e in engines}, 0
    for i, sentence in enumerate(SENTENCES, 1):
        chars += len(sentence)
        cells = []
        for key, _label, run in engines:
            name = f"{i}-{key}.mp3"
            if args.reuse and (OUT / name).exists():
                cells.append(f'<td><audio controls preload="none" src="{name}"></audio><small>saved earlier</small></td>')
                continue
            started = time.monotonic()
            try:
                audio = run(sentence)
                took = time.monotonic() - started
                totals[key] += took
                (OUT / name).write_bytes(audio)
                cells.append(f'<td><audio controls preload="none" src="{name}"></audio><small>{took:.1f} s</small></td>')
                print(f"{i}. {key:<24} {took:5.1f} s")
            except Exception as e:  # show the failure in the page instead of stopping
                cells.append(f"<td class=err>{html.escape(str(e))}</td>")
                print(f"{i}. {key:<24} failed: {e}")
        rows.append(
            f"<tr><th>{i}. {html.escape(sentence)}</th>{''.join(cells)}</tr>"
        )

    head = "".join(f"<th>{html.escape(label)}<br><small>total {totals[key]:.1f} s</small></th>" for key, label, _ in engines)
    page = f"""<!doctype html><meta charset="utf-8"><title>Mongolian TTS comparison</title>
<style>
body {{ font: 14px system-ui, sans-serif; margin: 24px; background: #111; color: #eee; }}
table {{ border-collapse: collapse; width: 100%; }} th, td {{ border: 1px solid #333; padding: 10px; vertical-align: top; text-align: left; }}
small {{ display: block; color: #999; margin-top: 4px; font-weight: normal; }} audio {{ width: 220px; }} .err {{ color: #f88; }}
</style>
<h1>Mongolian text to speech: listen and compare</h1>
<p>Same sentences for every engine, numbers as digits. About {chars} characters per engine.</p>
<table><tr><th>Sentence</th>{head}</tr>{''.join(rows)}</table>"""
    index = OUT / "index.html"
    index.write_text(page, encoding="utf-8")
    print(f"\nComparison page: {index.resolve()}")
    if args.open:
        webbrowser.open(index.resolve().as_uri())
    return 0


if __name__ == "__main__":
    sys.exit(main())

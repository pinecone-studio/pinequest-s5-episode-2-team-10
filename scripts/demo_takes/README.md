# Example takes for the demo account

The demo account's "Агаар" pitch starts with three example takes in its "Progress by take" card, so
visitors see practice over time before recording anything. They are labelled "Example" on the page.
They are **real analyses** of recordings made for the demo, not hand-written results:

1. `takes_text.py`: three versions of the Агаар speech (sentence, pause after, speed). Take 1 has
   fillers, a 4 s pause, no trial result or ask, and a rushed (1.6x) ending; take 2 is better; take 3
   makes every main point at a steady pace.
2. `make_takes_eleven.py <ffmpeg>`: speaks them with the app's coach voice (ElevenLabs, Mongolian)
   through a running local web app (`/api/tts`, demo login on the local backend), and joins them with
   the pauses and speed-ups. Writes `take1..3.wav` here (not committed).
3. `analyse_takes.py [backend] [take…]`: runs `pipeline.run.analyze` on them (the voice server and
   Gemma, with the pitch's idea, main points and `agaar.pdf`) and writes `takes.json` with what the
   takes card needs. Run from the repository root with `PYTHONPATH` set to it.

Copy `takes.json` to `web/public/defaults/demo/agaar-takes.json`. `tests/check_takes.ts` checks that
the examples still tell an improving story.

The recordings are synthetic speech, so speech recognition drops some of the fillers the voice says
(take 1 and take 2 both measure about 2.9 fillers per 100 words).

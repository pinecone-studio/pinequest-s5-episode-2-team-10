"""Checks for the delivery rules (pipeline/delivery.py) on made-up word timings.

Run from the repository root: python -m pytest tests
"""

import unittest

from pipeline import delivery
from pipeline.feedback import Recommendation
from pipeline.segments import to_sentences


def speech(n: int, start: float, end: float, word: str = "үг") -> list[dict]:
    step = (end - start) / n
    return [{"word": word, "start": start + i * step, "end": start + (i + 0.8) * step} for i in range(n)]


def run(words, levels=None, fillers=()):
    sentences = to_sentences(words)
    recs, facts = delivery.check(words, sentences, levels or [-20.0] * len(words), list(fillers))
    return recs, facts, sentences


def problems(recs):
    return [r["problem"] for r in recs]


class Delivery(unittest.TestCase):
    def test_steady_speech_has_nothing_to_report(self):
        recs, facts, _ = run(speech(240, 0, 120))
        self.assertEqual(recs, [])
        self.assertEqual(facts["usual_wpm"], 120)

    def test_too_few_words(self):
        recs, facts, _ = run(speech(20, 0, 10))
        self.assertEqual(recs, [])
        self.assertIsNone(facts["usual_wpm"])

    def test_speeding_up_at_the_end_is_reported_once(self):
        recs, _, _ = run(speech(180, 0, 90) + speech(100, 90, 120))
        found = problems(recs)
        self.assertTrue(any(p.startswith("Төгсгөлдөө яарсан") for p in found), found)
        self.assertFalse(any(p.startswith("Яаран ярьсан хэсэг") for p in found), found)

    def test_rushed_stretch_in_the_middle(self):
        recs, _, _ = run(speech(80, 0, 40) + speech(100, 40, 70) + speech(100, 70, 120))
        self.assertTrue(any(p.startswith("Яаран ярьсан хэсэг") for p in problems(recs)))

    def test_long_pause_points_to_where_speech_resumes(self):
        words = speech(100, 0, 50) + speech(100, 54, 104)
        recs, facts, _ = run(words)
        self.assertEqual(facts["long_pauses"], 1)
        pause = next(r for r in recs if "завсарлага" in r["problem"])
        self.assertIn("0:50", pause["problem"])
        self.assertAlmostEqual(pause["start_s"], 54.0, places=2)

    def test_filler_burst_uses_confirmed_fillers(self):
        words = speech(120, 0, 60)
        sentences = to_sentences(words)
        # Four confirmed fillers in sentences that start within 20 s of each other.
        sid = [i for i, s in enumerate(sentences) if 20 <= s["start"] <= 35]
        burst = [{"sentence_id": sid[0], "word": "аан"}] * 2 + [{"sentence_id": sid[-1], "word": "ээ"}] * 2
        recs, facts, _ = run(words, fillers=burst)
        self.assertEqual(facts["filler_bursts"], 1)
        # The same four spread over the whole pitch: no burst.
        spread = [{"sentence_id": i, "word": "аан"} for i in (0, len(sentences) // 3, 2 * len(sentences) // 3, len(sentences) - 1)]
        recs, facts, _ = run(words, fillers=spread)
        self.assertEqual(facts["filler_bursts"], 0)

    def test_fading_sentences(self):
        words, levels = [], []
        for s in range(6):  # six 8-word sentences, 1 s apart, last two words 10 dB quieter
            words += speech(8, s * 5, s * 5 + 4)
            levels += [-20.0] * 6 + [-30.0, -30.0]
        recs, facts, _ = run(words, levels)
        self.assertEqual(facts["fading_sentences"], 6)
        self.assertTrue(any("дуу суларсан" in p for p in problems(recs)))

    def test_one_quiet_last_word_is_not_a_fade(self):
        words, levels = [], []
        for s in range(6):
            words += speech(8, s * 5, s * 5 + 4)
            levels += [-20.0] * 7 + [-30.0]  # only the very last word is quiet (a soft ending)
        recs, facts, _ = run(words, levels)
        self.assertEqual(facts["fading_sentences"], 0)

    def test_without_loudness_the_fade_check_is_skipped(self):
        words = speech(48, 0, 30)
        recs, facts, _ = run(words, [None] * len(words))
        self.assertEqual(facts["checked_sentences"], 0)

    def test_findings_fit_the_report_schema_and_point_at_a_sentence(self):
        words = speech(180, 0, 90) + speech(100, 94, 124)
        recs, _, sentences = run(words)
        self.assertTrue(recs)
        starts = {round(s["start"], 2) for s in sentences}
        for r in recs:
            Recommendation.model_validate(r)
            self.assertEqual(r["area"], "delivery")
            # The page shows the sentence said at start_s, so it must fall inside one.
            self.assertTrue(any(s["start"] - 0.05 <= r["start_s"] < s["end"] + 0.05 for s in sentences), (r, starts))


if __name__ == "__main__":
    unittest.main()

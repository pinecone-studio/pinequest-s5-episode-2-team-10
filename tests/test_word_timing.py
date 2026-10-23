"""Checks for voiced-span detection, chunking and word time estimates.

Run from the repository root: python -m unittest discover tests
"""

import unittest

import numpy as np

from pipeline import word_timing as wt

SR = 16000


def tone(seconds: float) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.full(int(seconds * SR), 1e-4, dtype=np.float32)


class VoicedSpans(unittest.TestCase):
    def test_finds_sound_between_silences(self):
        audio = np.concatenate([silence(1), tone(2), silence(1.5), tone(1), silence(1)])
        spans = wt.voiced_spans(audio, SR)
        self.assertEqual(len(spans), 2)
        self.assertAlmostEqual(spans[0][0], 1.0, delta=0.05)
        self.assertAlmostEqual(spans[0][1], 3.0, delta=0.05)
        self.assertAlmostEqual(spans[1][0], 4.5, delta=0.05)

    def test_quiet_speaker_next_to_loud_one_still_counts(self):
        audio = np.concatenate([silence(1), tone(2), silence(1), tone(2) * 0.01, silence(1)])
        self.assertEqual(len(wt.voiced_spans(audio, SR)), 2)

    def test_short_gaps_are_merged(self):
        self.assertEqual(wt.merge_gaps([(0, 1), (1.1, 2), (3, 4)], 0.15), [(0, 2), (3, 4)])

    def test_empty_audio(self):
        self.assertEqual(wt.voiced_spans(np.zeros(10, dtype=np.float32), SR), [])


class ChunkBounds(unittest.TestCase):
    def test_splits_at_sentence_pauses(self):
        spans = [(0.5, 4.0), (4.5, 8.0), (8.1, 9.0)]
        self.assertEqual(wt.chunk_bounds(10.0, spans), [(0.3, 4.2), (4.3, 9.2)])

    def test_short_bits_join_the_next_piece(self):
        self.assertEqual(wt.chunk_bounds(5.0, [(0.0, 1.0), (1.5, 4.0)]), [(0.0, 4.2)])

    def test_long_speech_is_split_and_capped(self):
        spans = [(float(i), i + 0.9) for i in range(60)]  # one minute, 0.1 s gaps
        pieces = wt.chunk_bounds(60.0, spans)
        self.assertGreater(len(pieces), 3)
        self.assertTrue(all(e - s <= wt.MAX_CHUNK_S for s, e in pieces))
        for a, b in zip(pieces, pieces[1:]):
            self.assertLessEqual(a[1], b[0])

    def test_continuous_sound_is_cut_at_max(self):
        pieces = wt.chunk_bounds(60.0, [(0.0, 60.0)])
        self.assertTrue(all(e - s <= wt.MAX_CHUNK_S + 0.2 for s, e in pieces))
        self.assertEqual(pieces[-1][1], 60.0)

    def test_no_sound(self):
        self.assertEqual(wt.chunk_bounds(3.0, []), [(0.0, 3.0)])


class SpreadWords(unittest.TestCase):
    def test_words_stay_inside_spans_and_in_order(self):
        spans = [(1.0, 3.0), (5.0, 6.0)]
        words = wt.spread_words("нэг хоёр гурав дөрөв".split(), spans)
        self.assertEqual([w["word"] for w in words], ["нэг", "хоёр", "гурав", "дөрөв"])
        self.assertEqual(words[0]["start"], 1.0)
        self.assertEqual(words[-1]["end"], 6.0)
        for a, b in zip(words, words[1:]):
            self.assertLessEqual(a["end"], b["start"])
        for w in words:
            self.assertFalse(3.0 < w["start"] < 5.0, w)

    def test_pause_appears_between_spans(self):
        words = wt.spread_words(["aaaa", "bbbb"], [(0.0, 1.0), (3.0, 4.0)])
        self.assertEqual((words[0]["end"], words[1]["start"]), (1.0, 3.0))

    def test_word_never_straddles_a_silence(self):
        words = wt.spread_words(["ab", "abcdef", "ab"], [(0.0, 1.0), (5.0, 6.0)])
        for w in words:
            self.assertFalse(w["start"] < 1.0 < 5.0 < w["end"], w)

    def test_nothing_to_place(self):
        self.assertEqual(wt.spread_words([], [(0, 1)]), [])
        self.assertEqual(wt.spread_words(["a"], []), [])


if __name__ == "__main__":
    unittest.main()

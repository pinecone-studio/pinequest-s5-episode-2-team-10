"""Checks for per-word loudness (pipeline/loudness.py).

Run from the repository root: python -m pytest tests
"""

import unittest

import numpy as np

from pipeline import loudness

SR = 16000


def tone(seconds: float, amp: float) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.full(int(seconds * SR), 1e-4, dtype=np.float32)


class WordLevels(unittest.TestCase):
    def test_quieter_word_reads_lower(self):
        # loud word 0.5-1.5 s, quiet word (1/4 amplitude, about -12 dB) 1.5-2.5 s
        audio = np.concatenate([silence(0.5), tone(1, 0.4), tone(1, 0.1), silence(1)])
        words = [{"word": "a", "start": 0.5, "end": 1.5}, {"word": "b", "start": 1.5, "end": 2.5}]
        loud, quiet = loudness.word_levels(audio, SR, words)
        self.assertIsNotNone(loud)
        self.assertIsNotNone(quiet)
        self.assertAlmostEqual(loud - quiet, 12.0, delta=1.0)

    def test_silent_span_has_no_level(self):
        audio = np.concatenate([tone(1, 0.3), silence(2)])
        levels = loudness.word_levels(audio, SR, [{"word": "x", "start": 1.5, "end": 2.5}])
        self.assertEqual(levels, [None])

    def test_times_past_the_end_are_safe(self):
        audio = tone(1, 0.3)
        levels = loudness.word_levels(audio, SR, [{"word": "x", "start": 0.8, "end": 5.0},
                                                  {"word": "y", "start": 9.0, "end": 9.5}])
        self.assertIsNotNone(levels[0])
        self.assertIsNone(levels[1])

    def test_empty_audio(self):
        self.assertEqual(loudness.word_levels(np.zeros(0, dtype=np.float32), SR, [{"word": "x", "start": 0, "end": 1}]), [None])


if __name__ == "__main__":
    unittest.main()

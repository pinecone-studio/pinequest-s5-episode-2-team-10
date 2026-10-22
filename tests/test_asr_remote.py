"""Checks for the voice server response parser (PITCH_ASR=remote).

Run from the repository root: python -m unittest discover tests
"""

import unittest

from pipeline.asr import parse_remote_words


class ParseRemoteWords(unittest.TestCase):
    def test_valid_words(self):
        body = {"words": [{"word": " Сайн ", "start": 0, "end": 0.4}, {"word": "байна", "start": 0.5, "end": 0.9}]}
        self.assertEqual(
            parse_remote_words(body),
            [{"word": "Сайн", "start": 0.0, "end": 0.4}, {"word": "байна", "start": 0.5, "end": 0.9}],
        )

    def test_empty_list_means_no_speech(self):
        self.assertEqual(parse_remote_words({"words": []}), [])

    def test_missing_end_uses_start_and_end_never_before_start(self):
        body = {"words": [{"word": "a", "start": 1.0, "end": None}, {"word": "b", "start": 2.0, "end": 1.5}]}
        self.assertEqual(
            parse_remote_words(body), [{"word": "a", "start": 1.0, "end": 1.0}, {"word": "b", "start": 2.0, "end": 2.0}]
        )

    def test_blank_words_are_dropped(self):
        self.assertEqual(parse_remote_words({"words": [{"word": "  ", "start": 0, "end": 1}]}), [])

    def test_malformed_bodies_are_rejected(self):
        for body in (None, [], {}, {"words": "x"}, {"words": [1]}, {"words": [{"word": 3, "start": 0}]},
                     {"words": [{"word": "a", "start": "0"}]}, {"words": [{"word": "a", "start": True}]}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                parse_remote_words(body)


if __name__ == "__main__":
    unittest.main()

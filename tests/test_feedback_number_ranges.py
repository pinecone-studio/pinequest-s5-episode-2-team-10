"""Slide lists in the rule-based feedback are written as ranges, not 22 numbers in a row."""

from pipeline.feedback import number_ranges


def test_consecutive_slides_become_a_range():
    assert number_ranges([1] + list(range(3, 24))) == "1, 3–23"


def test_short_runs_stay_as_numbers():
    assert number_ranges([2, 3]) == "2, 3"
    assert number_ranges([1, 3, 5]) == "1, 3, 5"


def test_several_ranges_and_unsorted_input():
    assert number_ranges([9, 8, 7, 1, 2, 3, 5]) == "1–3, 5, 7–9"


def test_empty():
    assert number_ranges([]) == ""

import pytest
from pydantic import ValidationError

from pipeline import feedback


def _data(wpm=None):
    return {
        "metrics": {"wpm": wpm},
        "wording": {"fillers_per_100": 0, "word_count": 120},
        "pitch": {"key_points": []},
        "transcript": [],
        "alignment": [],
        "number_candidates": [],
        "filler_candidates": [],
    }


def test_rules_feedback_always_has_at_least_two_valid_practice_tasks():
    raw = feedback._rules(_data(wpm=165))
    parsed = feedback.Feedback.model_validate(raw)

    assert len(parsed.practice_tasks) == 2
    assert parsed.practice_tasks[0].title == "Ярианы дасгал"
    assert all(task.instruction and task.goal for task in parsed.practice_tasks)


def test_rules_feedback_adds_neutral_tasks_when_there_are_no_recommendations():
    raw = feedback._rules(_data())
    parsed = feedback.Feedback.model_validate(raw)

    assert [task.title for task in parsed.practice_tasks] == [
        "Гол санаагаа цэгцлэх",
        "Төгсгөлөө давтах",
    ]


def test_feedback_schema_requires_two_or_three_practice_tasks():
    raw = feedback._rules(_data())
    raw["practice_tasks"] = raw["practice_tasks"][:1]
    with pytest.raises(ValidationError):
        feedback.Feedback.model_validate(raw)

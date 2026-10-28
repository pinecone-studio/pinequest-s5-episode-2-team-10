import json

import pytest

from pipeline.feedback import FeedbackError, _parse_json


def test_parse_json_accepts_json_surrounded_by_model_preamble_and_fence():
    expected = {"summary": "Сайн эхлэл.", "recommendations": []}
    output = f"Here is the result:\n```json\n{json.dumps(expected, ensure_ascii=False)}\n```"

    assert _parse_json(output) == expected


def test_parse_json_rejects_malformed_model_output():
    with pytest.raises(FeedbackError, match="valid JSON"):
        _parse_json("{not json}")

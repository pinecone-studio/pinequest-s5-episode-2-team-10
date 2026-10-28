"""Filler evaluation: placing occurrences at token positions, labelling sheets and scores."""

import pytest

from training.fillers import evaluate, labels, sheet


# ---- Positions --------------------------------------------------------------


def test_positions_take_occurrences_left_to_right():
    words = ["ээ", "бид", "ээ", "апп", "ээ"]
    assert labels.positions(words, ["ээ", "ээ"]) == {0, 2}


def test_positions_place_phrases_and_never_reuse_a_token():
    words = ["тэгээд", "тэгээд", "бид", "тэгээд"]
    # The phrase takes the first two; the single word goes to the next free one.
    assert labels.positions(words, ["тэгээд тэгээд", "тэгээд"]) == {0, 1, 3}


def test_positions_ignore_words_not_in_the_sentence():
    # "ээж" (mother) is not "ээ"; extra occurrences beyond what the sentence has are dropped.
    assert labels.positions(["миний", "ээж"], ["ээ"]) == set()
    assert labels.positions(["ээ", "бид"], ["ээ", "ээ", "Аан!"]) == {0}


# ---- Sheet ------------------------------------------------------------------


def test_sheet_premarks_list_fillers_per_sentence():
    rows = sheet.rows_for("p1", "Ээ, бид апп хийсэн. Тэгээд тэгээд миний ээж дэмжсэн.")
    assert [r["sentence_id"] for r in rows] == [0, 1]
    assert rows[0]["tokens"][:2] == ["ээ", "бид"] and rows[0]["filler_idx"] == [0]
    assert rows[1]["filler_idx"] == [0, 1]  # "тэгээд тэгээд", not "ээж"
    assert not any(r["checked"] for r in rows)


# ---- Scores -----------------------------------------------------------------


def row(pitch, sid, tokens, gold):
    return {"pitch": pitch, "sentence_id": sid, "text": " ".join(tokens), "tokens": tokens,
            "filler_idx": gold, "checked": True}


def test_score_counts_tokens_and_per_word_errors():
    rows = [row("p", 0, ["ээ", "бид", "тэгээд", "явсан"], [0]),
            row("p", 1, ["аан", "тэгээд", "ээ"], [0, 2])]
    predicted = {("p", 0): {0, 2}, ("p", 1): {0}}
    s = labels.score(rows, predicted)
    assert (s["tp"], s["fp"], s["fn"]) == (2, 1, 1)
    assert s["precision"] == pytest.approx(2 / 3)
    assert s["recall"] == pytest.approx(2 / 3)
    assert s["f1"] == pytest.approx(2 / 3)
    assert s["per_word"]["тэгээд"] == {"tp": 0, "fp": 1, "fn": 0}
    assert s["per_word"]["ээ"] == {"tp": 1, "fp": 0, "fn": 1}


def test_score_edge_cases():
    rows = [row("p", 0, ["бид", "явсан"], [])]
    assert labels.score(rows, {})["f1"] is None  # nothing to find, nothing found
    assert labels.score(rows, {("p", 0): {0}})["f1"] == 0.0
    missed = labels.score([row("p", 0, ["ээ"], [0])], {})
    assert (missed["recall"], missed["f1"]) == (0.0, 0.0)


def test_list_prediction_matches_its_own_premarks():
    rows = sheet.rows_for("p1", "Ээ, бид нөгөө апп хийсэн. Тэгээд тэгээд дэмжсэн.")
    s = labels.score(rows, evaluate.predict_list(rows))
    assert (s["fp"], s["fn"]) == (0, 0)


def test_rules_backend_runs_end_to_end():
    rows = sheet.rows_for("p1", "Ээ, бид апп хийсэн. Нөгөө оюутнууд ашиглана. Аан, баярлалаа.")
    pred = evaluate.predict_backend("rules", rows)
    assert pred is not None
    assert labels.score(rows, pred)["fn"] == 0

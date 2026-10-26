"""Numbers are spelled out in Mongolian before the coach voice reads text (the model reads letters only)."""

import pytest

from pipeline.tts import number_words, spell_numbers


@pytest.mark.parametrize(
    "n, alone, joined",
    [
        (0, "тэг", "тэг"),
        (3, "гурав", "гурван"),
        (15, "арван тав", "арван таван"),
        (24, "хорин дөрөв", "хорин дөрвөн"),
        (100, "зуу", "зуун"),
        (150, "зуун тавь", "зуун тавин"),
        (203, "хоёр зуун гурав", "хоёр зуун гурван"),
        (1000, "мянга", "мянган"),
        (2024, "хоёр мянга хорин дөрөв", "хоёр мянга хорин дөрвөн"),
        (12500, "арван хоёр мянга таван зуу", "арван хоёр мянга таван зуун"),
        (2_500_000, "хоёр сая таван зуун мянга", "хоёр сая таван зуун мянган"),
    ],
)
def test_number_words(n, alone, joined):
    assert number_words(n) == alone
    assert number_words(n, joined=True) == joined


@pytest.mark.parametrize(
    "text, spoken",
    [
        ("Бид 2024 онд 150 оюутантай туршсан.", "Бид хоёр мянга хорин дөрвөн онд зуун тавин оюутантай туршсан."),
        ("Оюутнуудын 25% нь айдаг.", "Оюутнуудын хорин таван хувь нь айдаг."),
        ("0.96 оноо", "тэг цэг ерэн зургаа оноо"),
        ("Хариулт: 7.", "Хариулт: долоо."),
        ("Үгсгүй текст", "Үгсгүй текст"),
    ],
)
def test_spell_numbers(text, spoken):
    assert spell_numbers(text) == spoken

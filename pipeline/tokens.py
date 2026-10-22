"""Word tokens shared by the text checks, filler detection and slide matching."""

import re

WORD_RE = re.compile(r"\w+")


def tokens(text: str) -> list[str]:
    """Lowercase word tokens (Cyrillic included); punctuation is dropped."""
    return WORD_RE.findall(text.lower())

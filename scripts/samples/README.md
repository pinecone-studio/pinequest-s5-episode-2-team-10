# Sample transcripts

`pitch_fillers.txt` is a short pitch written to test filler detection. What a good result looks like:

| Sentence | Word | Expected |
| --- | --- | --- |
| 1 | ээ | filler |
| 2 | аан | filler |
| 3 | нөгөө, юу гэдэг юм | fillers (padding while searching for a word) |
| 5 | Тэгээд (sentence start) | judgement call: "so" as padding, or "then" |
| 6 | тэгээд | **not** a filler: "and then" joins two steps |
| 7 | ээ | filler |
| 8 | Нөгөө (in "Нөгөө төсөл") | **not** a filler: "that project" |
| 8 | мм | filler |
| 9 | За | likely filler ("okay, so"); not on the word list |
| 10 | Энэ, энэ | false start; not on the word list |

The word list alone finds 7 candidates, including the meaningful "Нөгөө" in sentence 8. A good model drops that one and adds "За" and the repeated "энэ".

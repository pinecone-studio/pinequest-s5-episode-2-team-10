"""Builds the slide decks of the demo pitches (web/public/defaults/demo/*.pdf).

The startups and their numbers are made up for the demo. The pitch data (idea, main points,
speech text) is in web/src/lib/demoPitches.ts; keep the slide numbers there in step with these.

    uv run --no-project --with pymupdf --with pymupdf-fonts --with fonttools python scripts/make_demo_decks.py

FiraGO (SIL Open Font License, from pymupdf-fonts) is embedded for the Cyrillic text.
"""

from pathlib import Path

import pymupdf

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "defaults" / "demo"
W, H = 960, 540

# slug, background colour, slides as (title, lines)
DECKS = [
    (
        "agaar",
        (0.09, 0.42, 0.55),
        [
            ("Агаар", ["Цэцэрлэгийн агаарын чанарыг бодит цагт хянана"]),
            ("Асуудал", ["Өвөл утаатай өдрүүдэд хүүхдүүд өрөөн дотор ч бохир агаар амьсгалдаг", "Цэцэрлэгүүд агаарын чанараа хэмждэггүй"]),
            ("Шийдэл", ["Хямд мэдрэгч өрөө бүрт", "Эцэг эхчүүд агаарын чанарыг утсаараа харна", "Агаар цэвэршүүлэгч автоматаар асна"]),
            ("Туршилтын үр дүн", ["12 цэцэрлэг, 3 сар", "Өрөөн доторх PM2.5 дунджаар 40%-иар буурсан"]),
            ("Хүсэлт", ["Дараагийн алхам: 50 цэцэрлэг", "120 сая төгрөгийн хөрөнгө оруулалт"]),
        ],
    ),
    (
        "malchin-market",
        (0.55, 0.36, 0.16),
        [
            ("МалчинМаркет", ["Малчид ноолуураа үйлдвэрт шууд зарна"]),
            ("Асуудал", ["Малчид ноолуураа зуучлагчаар дамжуулан зардаг", "Үнийн ихэнх нь зуучлагчид үлддэг"]),
            ("Шийдэл", ["Малчин ноолуураа апп дээр байршуулна", "Үйлдвэр чанарыг нь шалгаад шууд худалдаж авна", "Төлбөр дансанд шууд орно"]),
            ("Үр дүн", ["200 малчин бүртгүүлсэн", "Малчны авах үнэ 18%-иар өссөн"]),
            ("Хүсэлт", ["3 аймагт тэлэх", "Ноолуурын 2 үйлдвэртэй гэрээ хийх"]),
        ],
    ),
    (
        "unshaach",
        (0.36, 0.27, 0.6),
        [
            ("Уншаач", ["Хүүхдэд монголоор унших дадал суулгах AI багш"]),
            ("Асуудал", ["Бага ангийн олон хүүхэд унших дадалгүй", "Эцэг эхчүүд гэрээр туслах цаг гаргаж чаддаггүй"]),
            ("Шийдэл", ["Хүүхэд чангаар уншина, апп сонсож алдааг нь засна", "Хүүхдийн түвшинд тохирсон үлгэр"]),
            ("Үр дүн", ["300 хүүхэд, 6 долоо хоног", "Минутад уншдаг үг 25%-иар нэмэгдсэн"]),
        ],
    ),
    (
        "emch-online",
        (0.1, 0.48, 0.38),
        [
            ("ЭмчОнлайн", ["Сумын иргэдийг хотын эмчтэй видеогоор холбоно"]),
            ("Асуудал", ["Сумын эмнэлэгт нарийн мэргэжлийн эмч ховор", "Хот руу явахад өдөр, мөнгө их зарцуулна"]),
            ("Шийдэл", ["Сумын эмнэлгээс видео зөвлөгөө", "Шинжилгээний хариуг эмч онлайнаар харна"]),
            ("Үр дүн", ["35 сумд ажиллаж байна", "Сард 1,200 зөвлөгөө"]),
            ("Хүсэлт", ["Эрүүл мэндийн яамтай хамтран 100 сумд нэвтрүүлэх"]),
        ],
    ),
    (
        "avtobus",
        (0.62, 0.22, 0.25),
        [
            ("Автобус", ["Автобус хэзээ ирэхийг минут хүртэл нь харуулна"]),
            ("Асуудал", ["Зогсоол дээр хүйтэнд удаан хүлээдэг", "Хуваарь бодит байдалтай таардаггүй"]),
            ("Шийдэл", ["Автобусны GPS-ээр ирэх хугацааг тооцоолно", "Хүлээлгийн мэдэгдэл утсанд ирнэ"]),
            ("Хүсэлт", ["Нийтийн тээврийн газартай GPS өгөгдөл хуваалцах гэрээ"]),
        ],
    ),
]


def draw_deck(slides: list[tuple[str, list[str]]], colour: tuple[float, float, float], path: Path) -> None:
    doc = pymupdf.open()
    for index, (title, lines) in enumerate(slides):
        page = doc.new_page(width=W, height=H)
        page.draw_rect(page.rect, color=None, fill=colour)
        page.insert_font(fontname="F0", fontbuffer=pymupdf.Font("figo").buffer)
        page.insert_font(fontname="F1", fontbuffer=pymupdf.Font("figbo").buffer)
        white = (1, 1, 1)
        if index == 0:  # title slide
            page.insert_textbox(pymupdf.Rect(60, 170, W - 60, 290), title, fontname="F1", fontsize=64, color=white, align=1)
            page.insert_textbox(pymupdf.Rect(80, 300, W - 80, 380), lines[0], fontname="F0", fontsize=24, color=white, align=1)
            continue
        page.insert_textbox(pymupdf.Rect(70, 60, W - 70, 130), title, fontname="F1", fontsize=40, color=white)
        y = 170
        for line in lines:
            page.insert_textbox(pymupdf.Rect(90, y, W - 90, y + 80), f"•  {line}", fontname="F0", fontsize=26, color=white)
            y += 80
        page.insert_textbox(pymupdf.Rect(W - 120, H - 50, W - 40, H - 20), str(index + 1), fontname="F0", fontsize=14, color=white, align=2)
    doc.subset_fonts()  # keep only the glyphs used
    doc.save(path, garbage=4, deflate=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for slug, colour, slides in DECKS:
        path = OUT / f"{slug}.pdf"
        draw_deck(slides, colour, path)
        print(f"{path.relative_to(OUT.parent.parent.parent.parent)}  {len(slides)} slides  {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()

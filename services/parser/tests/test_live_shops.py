"""
Живий прогін парсера по магазинах родини (ROADMAP 8.3).

Не в CI: живі сторінки змінюються, а магазини по-різному пускають ботів
залежно від IP. Запускати вручну з кореня сервісу:

    pytest -m live            # усі посилання з tests/shop-links.txt
    pytest -m live -k allegro # лише один магазин

Кожне посилання — окремий тест: зелений, коли парсер дав назву. Після прогону
в `live-shops.md` (поруч із pytest.ini, у .gitignore) лежить таблиця
«магазин · назва · ціна · валюта · фото · джерела · помилка» — її переносимо
в API.md, розділ «Магазини родини». Звичайний `pytest` ці тести не збирає
(`addopts = -m "not live"`).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.extract import extract
from app.fetcher import fetch_html

LINKS = Path(__file__).parent / "shop-links.txt"
REPORT = Path(__file__).parent.parent / "live-shops.md"

pytestmark = pytest.mark.live


def read_links(path: Path = LINKS) -> list[tuple[str, str]]:
    """«Магазин | адреса» → пари; коментарі й порожні рядки пропускає."""
    out: list[tuple[str, str]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "|" not in line:
            continue
        shop, url = (part.strip() for part in line.split("|", 1))
        if shop and url.startswith(("http://", "https://")):
            out.append((shop, url))
    return out


_rows: list[dict[str, str]] = []


def _cell(value: object) -> str:
    text = "" if value is None else str(value)
    return text.replace("|", "/").replace("\n", " ")[:80]


@pytest.fixture(scope="module", autouse=True)
def report():
    yield
    if not _rows:
        return
    head = "| Магазин | Назва | Ціна | Валюта | Фото | Джерела | Помилка |\n|---|---|---|---|---|---|---|\n"
    body = "".join(
        f"| {r['shop']} | {r['title']} | {r['price']} | {r['currency']} | {r['image']} | {r['sources']} | {r['error']} |\n"
        for r in _rows
    )
    REPORT.write_text(head + body, encoding="utf-8")


LINK_LIST = read_links()


@pytest.mark.skipif(not LINK_LIST, reason="tests/shop-links.txt порожній — допиши посилання")
@pytest.mark.parametrize(("shop", "url"), LINK_LIST or [("—", "https://example.com")], ids=lambda v: str(v)[:40])
async def test_shop_page_gives_title(shop: str, url: str) -> None:
    row = {"shop": shop, "title": "", "price": "", "currency": "", "image": "", "sources": "", "error": ""}
    _rows.append(row)
    try:
        html = await fetch_html(url)
    except HTTPException as exc:
        row["error"] = _cell(exc.detail)
        pytest.fail(f"{shop}: сторінку не отримано ({exc.detail})")
    got = extract(html, url)
    row.update(
        title=_cell(got.title),
        price=_cell(got.price),
        currency=_cell(got.currency),
        image="так" if got.image_url else "",
        sources=_cell(", ".join(f"{k}:{v}" for k, v in sorted(got.confidence.items()))),
    )
    assert got.title, f"{shop}: назви немає — у формі людина допише сама"


def test_read_links_skips_comments_and_garbage(tmp_path: Path) -> None:
    # Розбір файлу перевіряється й без мережі — цей тест теж лише під -m live,
    # бо живе в цьому модулі; окремо його ганяти немає сенсу.
    f = tmp_path / "l.txt"
    f.write_text("# коментар\n\nAllegro | https://allegro.pl/x\nбез риски\nOLX | ftp://x\n", encoding="utf-8")
    assert read_links(f) == [("Allegro", "https://allegro.pl/x")]

"""
Ціна й назва з JSON-LD у формах, які трапились на живих сторінках магазинів
родини (ROADMAP 8.3): сутності в назві, AggregateOffer, priceSpecification,
список пропозицій без ціни в першій, ProductGroup з варіантами. Порядок
джерел той самий, що й у кнопки «У вішліст» (ADR-076).
"""

import json
from pathlib import Path

from app.extract import extract

FIXTURES = Path(__file__).parent / "fixtures"


def page(node: object) -> str:
    return f'<html><head><script type="application/ld+json">{json.dumps(node)}</script></head></html>'


def test_html_entities_in_jsonld_title_are_decoded():
    out = extract((FIXTURES / "amazon_like.html").read_text(encoding="utf-8"), "https://www.amazon.pl/dp/X")
    assert out.title == "DANISH ENDURANCE Bielizna Merino Męska, Długi Rękaw & Czarny"
    assert out.price == 129.95
    assert out.currency == "PLN"


def test_aggregate_offer_low_price():
    out = extract(page({"@type": "Product", "name": "Lampa", "offers": {"@type": "AggregateOffer", "lowPrice": "49,90", "priceCurrency": "PLN"}}), "https://s.pl/x")
    assert (out.price, out.currency, out.confidence["price"]) == (49.9, "PLN", "jsonld")


def test_price_specification_object_and_list():
    one = extract(page({"@type": "Product", "name": "A", "offers": {"priceSpecification": {"price": 14.99, "priceCurrency": "PLN"}}}), "https://s.pl/a")
    assert (one.price, one.currency) == (14.99, "PLN")
    many = extract(page({"@type": "Product", "name": "B", "offers": [{"priceSpecification": [{"price": "9.99", "priceCurrency": "EUR"}]}]}), "https://s.pl/b")
    assert (many.price, many.currency) == (9.99, "EUR")


def test_first_offer_without_price_is_skipped():
    out = extract(page({"@type": "Product", "name": "C", "offers": [{"@type": "Offer"}, {"price": "120", "priceCurrency": "UAH"}]}), "https://s.ua/c")
    assert (out.price, out.currency) == (120.0, "UAH")


def test_product_group_takes_first_variant_price():
    out = extract(
        page({"@type": "ProductGroup", "name": "Светр", "hasVariant": [{"@type": "Product"}, {"@type": "Product", "offers": {"price": 199, "priceCurrency": "UAH"}}]}),
        "https://s.ua/s",
    )
    assert (out.title, out.price, out.currency) == ("Светр", 199.0, "UAH")


def test_jsonld_price_beats_heuristic():
    html = page({"@type": "Product", "name": "D", "offers": {"lowPrice": "14.99", "priceCurrency": "PLN"}}).replace(
        "</head>", '</head><body><span class="price">4,99 zł</span></body>'
    )
    out = extract(html, "https://s.pl/d")
    assert (out.price, out.confidence["price"]) == (14.99, "jsonld")

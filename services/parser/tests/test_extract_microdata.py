"""
Microdata читається лише з області товару (ROADMAP 8.19, аудит 15 листопада: A-4).

Раніше бралися перші `itemprop="name"` та `image` на сторінці, а перед товаром
стоять шапка магазину (`Organization`) і хлібні крихти (`BreadcrumbList`) —
назвою ставав «Sklep XYZ», фото — логотип. Порядок джерел той самий:
JSON-LD → microdata → Open Graph → Twitter → <title>.
"""

import json

import pytest

from app.extract import extract

URL = "https://shop.example/p/1"

OG = (
    '<meta property="og:title" content="Rower dziecięcy 16 cali">'
    '<meta property="og:image" content="https://shop.example/img/rower.jpg">'
)
SHOP = (
    '<div itemscope itemtype="https://schema.org/Organization">'
    '<img itemprop="image" src="/logo.png"><span itemprop="name">Sklep XYZ</span></div>'
)
CRUMBS = (
    '<ol itemscope itemtype="https://schema.org/BreadcrumbList">'
    '<li itemprop="itemListElement" itemscope><span itemprop="name">Strona główna</span></li></ol>'
)


def product(inner: str, item_type: str = "https://schema.org/Product") -> str:
    return f'<div itemscope itemtype="{item_type}">{inner}</div>'


class TestShopHeaderIsNotTheProduct:
    def test_page_from_the_audit(self):
        html = OG + SHOP + CRUMBS + product(
            '<h1 itemprop="name">Rower dziecięcy 16 cali</h1><span itemprop="price" content="499.00">499 zł</span>'
        )
        out = extract(html, URL)
        assert out.title == "Rower dziecięcy 16 cali"
        assert out.image_url == "https://shop.example/img/rower.jpg"
        assert out.price == 499.0
        assert out.confidence == {"title": "microdata", "price": "microdata", "image_url": "og"}

    def test_without_product_scope_name_and_photo_come_from_open_graph(self):
        out = extract(OG + SHOP + CRUMBS, URL)
        assert (out.title, out.image_url) == ("Rower dziecięcy 16 cali", "https://shop.example/img/rower.jpg")
        assert (out.confidence["title"], out.confidence["image_url"]) == ("og", "og")

    def test_without_product_scope_and_open_graph_title_tag_wins_over_shop_name(self):
        out = extract("<title>Rower 16 cali — Sklep XYZ</title>" + SHOP + CRUMBS, URL)
        assert (out.title, out.confidence["title"]) == ("Rower 16 cali — Sklep XYZ", "title")
        assert out.image_url is None

    def test_shop_inside_the_product_scope_is_skipped_too(self):
        # <body itemscope itemtype=Product>: шапка магазину лежить усередині товару.
        html = f'<body itemscope itemtype="http://schema.org/Product">{SHOP}{CRUMBS}<h1 itemprop="name">Rower</h1></body>'
        out = extract(html, URL)
        assert (out.title, out.image_url) == ("Rower", None)

    def test_jsonld_still_wins_over_microdata(self):
        data = {"@type": "Product", "name": "З JSON-LD", "offers": {"price": "10", "priceCurrency": "UAH"}}
        html = f'<script type="application/ld+json">{json.dumps(data)}</script>' + product(
            '<h1 itemprop="name">З microdata</h1><meta itemprop="price" content="20">'
        )
        out = extract(html, URL)
        assert (out.title, out.price, out.confidence["title"]) == ("З JSON-LD", 10.0, "jsonld")


class TestProductScope:
    @pytest.mark.parametrize(
        "item_type",
        [
            "https://schema.org/Product",
            "http://schema.org/Product",
            "https://schema.org/Product/",
            "http://schema.org/Product/",
            "https://www.schema.org/Product",
            "https://schema.org/ProductGroup",
            "http://schema.org/ProductGroup/",
            "https://schema.org/Thing https://schema.org/Product",
        ],
    )
    def test_type_spellings(self, item_type):
        out = extract(SHOP + product('<h1 itemprop="name">Лампа</h1>', item_type), URL)
        assert (out.title, out.confidence["title"]) == ("Лампа", "microdata")

    @pytest.mark.parametrize(
        "item_type",
        ["https://schema.org/Organization", "https://schema.org/ProductModelX", "https://example.com/Product", ""],
    )
    def test_other_types_are_not_products(self, item_type):
        out = extract("<title>Сторінка</title>" + product('<h1 itemprop="name">Не товар</h1>', item_type), URL)
        assert (out.title, out.confidence["title"]) == ("Сторінка", "title")

    def test_nested_scopes_of_other_types_do_not_give_name_or_photo(self):
        html = product(
            '<div itemprop="brand" itemscope itemtype="https://schema.org/Brand">'
            '<span itemprop="name">Nike</span><img itemprop="image" src="/brand.png"></div>'
            '<div itemprop="review" itemscope itemtype="https://schema.org/Review"><b itemprop="name">Супер!</b></div>'
            '<div itemprop="image" itemscope itemtype="https://schema.org/ImageObject"><meta itemprop="url" content="/i.jpg"></div>'
            '<h1 itemprop="name">Кросівки</h1><img itemprop="image" src="/shoes.jpg">'
        )
        out = extract(html, URL)
        assert (out.title, out.image_url) == ("Кросівки", "https://shop.example/shoes.jpg")

    def test_price_from_offer_and_aggregate_offer(self):
        offer = product(
            '<h1 itemprop="name">A</h1><div itemprop="offers" itemscope itemtype="http://schema.org/Offer">'
            '<span itemprop="price" content="1299.00">1 299 грн</span><meta itemprop="priceCurrency" content="UAH">'
            '<span itemprop="name">Пропозиція дня</span></div>'
        )
        out = extract(offer, URL)
        assert (out.title, out.price, out.currency) == ("A", 1299.0, "UAH")

        aggregate = product(
            '<div itemprop="offers" itemscope itemtype="https://schema.org/AggregateOffer">'
            '<meta itemprop="lowPrice" content="49.90"><meta itemprop="priceCurrency" content="PLN"></div>'
            '<h1 itemprop="name">B</h1>'
        )
        out = extract(aggregate, URL)
        assert (out.title, out.price, out.currency, out.confidence["price"]) == ("B", 49.9, "PLN", "microdata")

    def test_product_group_takes_variant_price_but_not_its_name(self):
        html = product(
            '<h1 itemprop="name">Светр</h1>'
            + '<div itemprop="hasVariant" itemscope itemtype="https://schema.org/Product">'
            '<span itemprop="name">Светр, розмір M</span>'
            '<div itemprop="offers" itemscope itemtype="https://schema.org/Offer">'
            '<meta itemprop="price" content="199"><meta itemprop="priceCurrency" content="UAH"></div></div>',
            "https://schema.org/ProductGroup",
        )
        out = extract(html, URL)
        assert (out.title, out.price, out.currency) == ("Светр", 199.0, "UAH")

    def test_related_product_does_not_lend_its_price(self):
        # У головного товару ціни немає (розпродано) — ціна сусіда не підходить.
        related = (
            '<div itemprop="isRelatedTo" itemscope itemtype="https://schema.org/Product">'
            '<span itemprop="name">Дзвоник</span><meta itemprop="price" content="35"></div>'
        )
        neighbour = product('<span itemprop="name">Шолом</span><meta itemprop="price" content="120">')
        out = extract(product('<h1 itemprop="name">Велосипед</h1>' + related) + neighbour, URL)
        assert (out.title, out.price) == ("Велосипед", None)

    def test_first_product_with_a_name_is_the_one(self):
        html = product('<meta itemprop="price" content="1">') + product(
            '<h1 itemprop="name">Лампа</h1><meta itemprop="price" content="249.90">'
        )
        out = extract(html, URL)
        assert (out.title, out.price) == ("Лампа", 249.9)

    def test_link_with_name_gives_text_not_address(self):
        out = extract(product('<a itemprop="name" href="/p/1">Rower</a><link itemprop="image" href="/r.jpg">'), URL)
        assert (out.title, out.image_url) == ("Rower", "https://shop.example/r.jpg")

    def test_several_names_in_one_itemprop(self):
        out = extract(product('<h1 itemprop="name headline">Лампа</h1>'), URL)
        assert out.title == "Лампа"

    def test_empty_name_falls_back_to_open_graph(self):
        out = extract(OG + product('<h1 itemprop="name"> </h1><meta itemprop="price" content="5">'), URL)
        assert (out.title, out.confidence["title"], out.price) == ("Rower dziecięcy 16 cali", "og", 5.0)


class TestPriceWithoutProductScope:
    """Назва й фото — лише з товару; ціну з недбалої розмітки без itemscope беремо, як і раніше."""

    def test_loose_price_is_kept(self):
        html = OG + SHOP + '<span itemprop="price" content="499.00">499 zł</span><meta itemprop="priceCurrency" content="PLN">'
        out = extract(html, URL)
        assert (out.title, out.price, out.currency) == ("Rower dziecięcy 16 cali", 499.0, "PLN")
        assert out.confidence == {"title": "og", "image_url": "og", "price": "microdata", "currency": "microdata"}

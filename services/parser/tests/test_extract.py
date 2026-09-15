from pathlib import Path

from app.extract import extract, normalise_currency, parse_price

FIXTURES = Path(__file__).parent / "fixtures"


def read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_jsonld_wins_over_title():
    out = extract(read("jsonld.html"), "https://shop.example.com/p/1")
    assert out.title == "Sony WH-1000XM5"
    assert out.price == 1299.0
    assert out.currency == "PLN"
    # Відносний шлях картинки розгортається в абсолютний
    assert out.image_url == "https://shop.example.com/img/a.jpg"
    assert out.confidence["title"] == "jsonld"
    assert out.partial is False


def test_opengraph_with_spaced_price():
    out = extract(read("og.html"), "https://example.com/x")
    assert out.title == "Ковдра вовняна"
    assert out.price == 1299.0
    assert out.currency == "UAH"
    assert out.site_name == "Example Shop"


def test_microdata():
    out = extract(read("microdata.html"), "https://example.com/x")
    assert out.title == "Лампа настільна"
    assert out.price == 249.9
    assert out.currency == "PLN"


def test_bare_page_is_partial_but_keeps_title():
    out = extract(read("bare.html"), "https://example.com/x")
    assert out.title == "Просто сторінка"
    assert out.price is None
    assert out.partial is True
    assert out.site_name == "example.com"


class TestPrice:
    def test_polish_format(self):
        assert parse_price("1 299,00 zł") == 1299.0

    def test_english_format(self):
        assert parse_price("1,299.00") == 1299.0

    def test_thousands_without_decimals(self):
        assert parse_price("1.299") == 1299.0

    def test_plain(self):
        assert parse_price("399") == 399.0

    def test_number(self):
        assert parse_price(249.9) == 249.9

    def test_garbage(self):
        assert parse_price("від") is None
        assert parse_price("") is None
        assert parse_price(None) is None

    def test_negative_rejected(self):
        assert parse_price(-5) is None


class TestCurrency:
    def test_code(self):
        assert normalise_currency("pln") == "PLN"

    def test_sign(self):
        assert normalise_currency("1299 zł") == "PLN"
        assert normalise_currency("399 грн") == "UAH"
        assert normalise_currency("$19") == "USD"

    def test_unknown(self):
        assert normalise_currency("") is None
        assert normalise_currency("бали") is None


class TestConfigReadiness:
    """supabase_ready відсікає найчастішу причину 503 — незаповнений шаблон."""

    def test_placeholder_is_not_ready(self):
        from app.config import Settings

        assert Settings(supabase_url="https://<project-ref>.supabase.co").supabase_ready is False

    def test_empty_is_not_ready(self):
        from app.config import Settings

        assert Settings(supabase_url="").supabase_ready is False

    def test_real_url_is_ready(self):
        from app.config import Settings

        assert Settings(supabase_url="https://abcdefgh.supabase.co").supabase_ready is True


class TestHeuristicPrice:
    """Запасний шлях для магазинів без розмітки ціни (IKEA тощо)."""

    def test_price_from_text_when_markup_has_none(self):
        out = extract(read("price_in_text.html"), "https://www.ikea.com/pl/pl/p/x/")
        assert out.title == "IKEA 365+ Kubek"
        assert out.price == 9.99
        assert out.confidence["price"] == "heuristic"
        assert out.confidence["title"] == "og"

    def test_markup_still_wins_over_heuristic(self):
        out = extract(read("jsonld.html"), "https://shop.example.com/p/1")
        assert out.confidence["price"] == "jsonld"


class TestStripTracking:
    def test_ad_params_removed(self):
        from app.cache import strip_tracking

        url = (
            "https://desktronic.pl/products/biurko?variant=40673677312035"
            "&tw_source=google&gad_source=1&gclid=ABC&gbraid=XYZ&utm_medium=cpc"
        )
        assert strip_tracking(url) == "https://desktronic.pl/products/biurko?variant=40673677312035"

    def test_meaningful_params_kept(self):
        from app.cache import strip_tracking

        url = "https://shop.pl/p?id=7&color=red"
        assert strip_tracking(url) == "https://shop.pl/p?id=7&color=red"


class TestPriceWithTrailingText:
    """Ці випадки давали 999 замість 9,99: крапка з 'szt.' читалась як роздільник."""

    def test_unit_suffix(self):
        assert parse_price("9,99/szt.") == 9.99

    def test_currency_and_full_stop(self):
        assert parse_price("299 zł.") == 299.0

    def test_price_inside_sentence(self):
        assert parse_price("Cena: 1 299,00 zł brutto") == 1299.0

    def test_leading_text(self):
        assert parse_price("od 49,90") == 49.9

    def test_no_digits(self):
        assert parse_price("brak ceny") is None


class TestHeuristicRejectsNoise:
    """«365» з назви «IKEA 365+» — не ціна."""

    def test_series_number_in_price_block_ignored(self):
        out = extract(read("ikea_like.html"), "https://www.ikea.com/pl/pl/p/x/")
        assert out.price == 9.99

    def test_bare_integer_without_currency_rejected(self):
        from app.extract import _looks_like_price

        assert _looks_like_price("365") is False
        assert _looks_like_price("IKEA 365+") is False

    def test_decimal_or_currency_accepted(self):
        from app.extract import _looks_like_price

        assert _looks_like_price("9,99/szt.") is True
        assert _looks_like_price("365 zł") is True
        assert _looks_like_price("399 грн") is True

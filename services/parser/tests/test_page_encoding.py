"""
Кодування сторінки (ROADMAP 8.19, аудит 15 листопада: A-2 і A-3).

Порядок, як у браузера: BOM → charset із Content-Type → <meta> на початку
сторінки → UTF-8. Невідома назва кодування — те саме, що відсутня, а не 500.

Мережі тут немає: DNS і транспорт підмінено так само, як у
test_fetch_pinning — перевірка адреси й пін на IP працюють по-справжньому.
"""

import codecs

import httpx
import pytest
from fastapi.testclient import TestClient

from app import fetcher
from app.auth import require_user
from app.config import Settings
from app.extract import extract
from app.fetcher import _meta_charset, _text_codec, decode_page, page_encoding
from app.main import app

URL = "https://shop.example/p/1"


def fake_dns(monkeypatch):
    def getaddrinfo(host, *_args, **_kwargs):
        if host != "shop.example":
            raise OSError(f"немає запису для {host}")
        return [(2, 1, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(fetcher.socket, "getaddrinfo", getaddrinfo)


async def fetch(monkeypatch, content_type: str, body: bytes) -> str:
    fake_dns(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        # Байтами: у заголовку від магазину може бути й не-ASCII.
        return httpx.Response(200, headers={"content-type": content_type.encode()}, content=body)

    return await fetcher.fetch_html(URL, transport=httpx.MockTransport(handler))


class TestUnknownCharsetInHeader:
    """A-2: `charset=foo-bar` давав LookupError і HTTP 500 замість сторінки."""

    async def test_unknown_name_is_read_as_utf8(self, monkeypatch):
        html = await fetch(monkeypatch, "text/html; charset=foo-bar", "<title>Подарунок</title>".encode())
        assert extract(html, URL).title == "Подарунок"

    @pytest.mark.parametrize(
        "label",
        [
            "foo-bar",
            "hex",  # є в реєстрі кодеків, але це не кодування тексту
            "base64",
            "rot13",
            "undefined",  # кидає UnicodeError на будь-яких байтах
            "idna",  # не вміє errors="replace"
            "punycode",  # на великій сторінці рахується хвилинами
            "cp037",  # EBCDIC: вебсторінок у ньому не буває
            "x" * 5000,
            "кодування",
            '""',
        ],
    )
    async def test_no_label_breaks_the_page(self, monkeypatch, label):
        html = await fetch(monkeypatch, f"text/html; charset={label}", b"<title>x</title>")
        assert extract(html, URL).title == "x"

    async def test_unknown_header_falls_through_to_meta(self, monkeypatch):
        body = '<html><head><meta charset="windows-1251"><title>Подарунок</title>'.encode("cp1251")
        html = await fetch(monkeypatch, "text/html; charset=foo-bar", body)
        assert extract(html, URL).title == "Подарунок"

    def test_parse_endpoint_answers_200_not_500(self, monkeypatch):
        # Той самий шлях, яким помилку відтворили: POST /parse цілком.
        fake_dns(monkeypatch)
        monkeypatch.setattr("app.main.settings", lambda: Settings(supabase_url="https://abcdefgh.supabase.co", _env_file=None))
        real_client = httpx.AsyncClient

        def client_with_fake_shop(**kwargs):
            kwargs["transport"] = httpx.MockTransport(
                lambda request: httpx.Response(
                    200, headers={"content-type": "text/html; charset=foo-bar"}, content=b"<title>x</title>"
                )
            )
            return real_client(**kwargs)

        monkeypatch.setattr(fetcher.httpx, "AsyncClient", client_with_fake_shop)
        app.dependency_overrides[require_user] = lambda: "user-charset"
        try:
            res = TestClient(app).post("/parse", json={"url": "https://shop.example/p/charset-foo-bar"})
        finally:
            app.dependency_overrides.pop(require_user, None)
        assert res.status_code == 200
        assert res.json()["title"] == "x"


class TestCharsetInMetaOnly:
    """A-3: кодування лише в <meta> читалось як UTF-8 — назва з «�»."""

    async def test_meta_charset_windows_1251(self, monkeypatch):
        body = '<html><head><meta charset="windows-1251"><title>Подарунок</title>'.encode("cp1251")
        html = await fetch(monkeypatch, "text/html", body)
        assert extract(html, URL).title == "Подарунок"

    async def test_meta_charset_iso_8859_2(self, monkeypatch):
        body = '<html><head><meta charset="iso-8859-2"><title>Książka żółć</title>'.encode("iso-8859-2")
        html = await fetch(monkeypatch, "text/html", body)
        assert extract(html, URL).title == "Książka żółć"

    async def test_meta_http_equiv(self, monkeypatch):
        body = (
            '<html><head><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=windows-1251">'
            "<title>Книжка</title>"
        ).encode("cp1251")
        html = await fetch(monkeypatch, "text/html", body)
        assert extract(html, URL).title == "Книжка"

    @pytest.mark.parametrize(
        "meta",
        [
            "<meta charset=windows-1251>",
            "<meta charset='windows-1251'/>",
            "<META CHARSET = \"Windows-1251\" >",
            '<meta content="text/html;charset=windows-1251" http-equiv=content-type>',
            "<meta http-equiv='Content-Type' content='text/html; charset=\"windows-1251\"'>",
            # Перед оголошенням — інші мета-теги й коментар із «>» усередині.
            '<meta name="viewport" content="width=device-width"><!-- a > b --><meta charset="windows-1251">',
        ],
    )
    def test_meta_spellings(self, meta):
        assert _meta_charset(f"<html><head>{meta}<title>x</title>".encode("ascii")) == "cp1251"

    def test_what_is_not_a_declaration(self):
        # Закоментований тег, опис зі словом charset, тег після перших 4 КБ.
        assert _meta_charset(b"<!-- <meta charset=koi8-r> --><title>x</title>") is None
        assert _meta_charset(b'<meta name="description" content="charset=koi8-r">') is None
        assert _meta_charset(b"<metadata charset=koi8-r>") is None
        assert _meta_charset(b"<p>" + b" " * 5000 + b"<meta charset=koi8-r>") is None
        assert _meta_charset(b"<!-- no end <meta charset=koi8-r>") is None
        assert _meta_charset(b"") is None

    def test_unknown_meta_label_is_skipped_and_next_one_used(self):
        assert _meta_charset(b"<meta charset=foo-bar><meta charset=koi8-u>") == "koi8-u"
        assert _meta_charset(b"<meta charset=foo-bar>") is None

    def test_utf16_in_meta_is_not_believed(self):
        # <meta> прочитався побайтно — отже, сторінка не UTF-16 (так каже й стандарт HTML).
        body = '<meta charset="utf-16"><title>Подарунок</title>'.encode()
        assert page_encoding(body, None) == "utf-8"
        assert "Подарунок" in decode_page(body, None)


class TestOrder:
    async def test_header_charset_still_works(self, monkeypatch):
        # Працювало й до виправлення — не зламати.
        html = await fetch(monkeypatch, "text/html; charset=windows-1251", "<title>Подарунок</title>".encode("cp1251"))
        assert extract(html, URL).title == "Подарунок"

    async def test_utf8_without_any_declaration(self, monkeypatch):
        html = await fetch(monkeypatch, "text/html", "<title>Подарунок żółć</title>".encode())
        assert extract(html, URL).title == "Подарунок żółć"

    async def test_utf8_header_and_utf8_meta(self, monkeypatch):
        body = '<meta charset="utf-8"><title>Подарунок</title>'.encode()
        html = await fetch(monkeypatch, "text/html; charset=UTF-8", body)
        assert extract(html, URL).title == "Подарунок"

    async def test_header_beats_meta(self, monkeypatch):
        # Сервер перекодував сторінку в UTF-8, а <meta> у шаблоні лишився старий:
        # браузер вірить заголовку — і ми теж.
        body = '<meta charset="windows-1251"><title>Подарунок</title>'.encode()
        html = await fetch(monkeypatch, "text/html; charset=utf-8", body)
        assert extract(html, URL).title == "Подарунок"

    async def test_quoted_and_uppercase_header(self, monkeypatch):
        html = await fetch(monkeypatch, 'text/html; charset="WINDOWS-1251"', "<title>Подарунок</title>".encode("cp1251"))
        assert extract(html, URL).title == "Подарунок"

    async def test_utf8_bom_beats_header_and_is_stripped(self, monkeypatch):
        body = codecs.BOM_UTF8 + "<title>Подарунок</title>".encode()
        html = await fetch(monkeypatch, "text/html; charset=windows-1251", body)
        assert html == "<title>Подарунок</title>"

    @pytest.mark.parametrize(("bom", "codec"), [(codecs.BOM_UTF16_LE, "utf-16-le"), (codecs.BOM_UTF16_BE, "utf-16-be")])
    async def test_utf16_bom(self, monkeypatch, bom, codec):
        html = await fetch(monkeypatch, "text/html", bom + "<title>Подарунок</title>".encode(codec))
        assert extract(html, URL).title == "Подарунок"

    async def test_utf16_named_in_header_without_bom(self, monkeypatch):
        html = await fetch(monkeypatch, "text/html; charset=utf-16le", "<title>Подарунок</title>".encode("utf-16-le"))
        assert extract(html, URL).title == "Подарунок"

    def test_codec_names(self):
        assert _text_codec("Windows-1251") == "cp1251"
        assert _text_codec(" utf8 ") == "utf-8"
        assert _text_codec("utf-16") == "utf-16"
        assert _text_codec("utf-16", from_meta=True) is None
        assert _text_codec(None) is None
        assert _text_codec("") is None


class TestBrokenBytes:
    async def test_wrong_bytes_become_replacement_marks_not_an_error(self, monkeypatch):
        # Заявлено UTF-8, а байти — windows-1251: назва зіпсована, але відповідь є.
        html = await fetch(monkeypatch, "text/html; charset=utf-8", "<title>Подарунок</title>".encode("cp1251"))
        assert html.startswith("<title>�") and html.endswith("</title>")

    async def test_page_cut_in_the_middle_of_a_character(self, monkeypatch):
        """Ліміт 5 МБ може розрізати багатобайтовий символ: хвіст відкидається мовчки."""
        monkeypatch.setattr(fetcher, "settings", lambda: Settings(parser_max_bytes=64, _env_file=None))
        head = "<title>Подарунок</title>".encode()
        body = head + b" " * (63 - len(head)) + "я".encode()[:1]  # 64 байти: від «я» вмістився лише перший
        assert len(body) == 64
        html = await fetch(monkeypatch, "text/html", body)
        assert extract(html, URL).title == "Подарунок"
        assert "\ufffd" not in html

    def test_truncated_tail_is_dropped_and_complete_page_keeps_the_mark(self):
        cut = "Подарунок".encode()[:-1]
        assert decode_page(cut, None, truncated=True) == "Подаруно"
        # Не обрізана сторінка з битим хвостом — це вже її власна помилка: видно «�».
        assert decode_page(cut, None) == "Подаруно�"
        assert decode_page("Подарунок".encode("utf-16-le")[:-1], "utf-16le", truncated=True) == "Подаруно"

    def test_empty_page(self):
        assert decode_page(b"", None) == ""
        assert decode_page(b"", "foo-bar", truncated=True) == ""

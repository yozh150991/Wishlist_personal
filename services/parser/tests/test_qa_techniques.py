"""
QA-регресія за техніками тест-дизайну (ADR-069) для сервісу парсера.

  EP   — класи записів ціни й валюти;
  BVA  — межі довжини адреси, токена, ліміту запитів, ємності й часу кешу;
  ST   — запис кешу: немає → є → протух → немає; ліміт: вільно → вичерпано → знову вільно;
  PW   — розбір ціни: розряди × дріб × позиція валюти (покривний масив);
  EG   — вгадування помилок: ціна з одним знаком дробу, Infinity у JSON-LD, «грн»,
         адреси, що ведуть у приватну мережу обхідними шляхами.

Відомі баги — `xfail(strict=True)` з номером із docs/QA_REPORT.md: тест
зелений, поки баг є, і червоніє, щойно його виправлено, — тоді позначка знімається.
Мережі тести не потребують.
"""

import asyncio
import ipaddress

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.requests import Request

from app import auth, cache, fetcher, main, ratelimit
from app.extract import extract, normalise_currency, parse_price
from app.models import ParseRequest, ParseResponse


# ═══════════════════════════════════════════════
# EP — класи еквівалентності
# ═══════════════════════════════════════════════

@pytest.mark.parametrize(
    ("raw", "want"),
    [
        (399, 399.0),                    # число
        (12.5, 12.5),                    # дробове число з JSON
        ("399", 399.0),                  # ціле рядком
        ("1 299,00 zł", 1299.0),         # польський запис
        ("1,299.00", 1299.0),            # англійський запис
        ("1.299,00 €", 1299.0),          # німецький запис
        ("299 грн.", 299.0),             # український із крапкою після валюти
        ("9,99/szt.", 9.99),             # ціна за штуку
        (-5, None),                      # від'ємне число — не ціна
        (None, None),
        ("", None),
        ("ціна за запитом", None),       # без цифр
    ],
)
def test_ep_price_classes(raw, want):
    assert parse_price(raw) == want


@pytest.mark.parametrize(
    ("raw", "want"),
    [("PLN", "PLN"), ("pln", "PLN"), ("zł", "PLN"), ("₴", "UAH"), ("299 грн.", "UAH"),
     ("€", "EUR"), ("$", "USD"), ("GBP", "GBP"), ("", None), (None, None), ("??", None)],
)
def test_ep_currency_classes(raw, want):
    assert normalise_currency(raw) == want


@pytest.mark.xfail(strict=True, reason="BUG-QA-21: «грн» — три літери, тож стає кодом «ГРН», а не UAH")
@pytest.mark.parametrize("raw", ["грн", "ГРН", "Грн"])
def test_ep_currency_bare_hryvnia_word(raw):
    assert normalise_currency(raw) == "UAH"


# ═══════════════════════════════════════════════
# BVA — граничні значення
# ═══════════════════════════════════════════════

@pytest.mark.parametrize(
    ("length", "ok"),
    [(7, False), (8, True), (2048, True), (2049, False)],
)
def test_bva_request_url_length(length, ok):
    url = ("https://a.pl/" + "x" * length)[:length]
    if ok:
        assert ParseRequest(url=url).url == url
    else:
        with pytest.raises(ValidationError):
            ParseRequest(url=url)


def _request(token: str) -> Request:
    return Request({"type": "http", "method": "POST", "path": "/parse",
                    "headers": [(b"authorization", f"Bearer {token}".encode())]})


def _token(total: int) -> str:
    # Форма JWT: дві короткі частини й довга третя, разом рівно `total` символів.
    return "a.b." + "c" * (total - 4)


def test_bva_token_8192_passes_shape_check(monkeypatch):
    class Reached(Exception):
        """Токен пройшов перевірку форми й дійшов до звернення в Supabase."""

    class Client:
        def __init__(self, *a, **k):
            raise Reached

    monkeypatch.setattr(auth.httpx, "AsyncClient", Client)
    monkeypatch.setattr(auth, "settings", _settings)
    auth._cache.clear()
    with pytest.raises(Reached):
        asyncio.run(auth.require_user(_request(_token(8192))))


def test_bva_token_8193_rejected_without_network(monkeypatch):
    class Forbidden:
        def __init__(self, *a, **k):
            raise AssertionError("до Supabase не мало дійти")

    monkeypatch.setattr(auth.httpx, "AsyncClient", Forbidden)
    monkeypatch.setattr(auth, "settings", _settings)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(auth.require_user(_request(_token(8193))))
    assert (exc.value.status_code, exc.value.detail) == (401, "invalid_token")


def _settings():
    from app.config import Settings
    return Settings(supabase_url="https://example.supabase.co", _env_file=None)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(ratelimit.time, "monotonic", c)
    monkeypatch.setattr(cache.time, "monotonic", c)
    ratelimit._hits.clear()
    cache._cache.clear()
    yield c
    ratelimit._hits.clear()
    cache._cache.clear()


def test_bva_rate_limit_20th_ok_21st_429(clock):
    for _ in range(20):
        ratelimit.check("user-a", 20)
    with pytest.raises(HTTPException) as exc:
        ratelimit.check("user-a", 20)
    assert exc.value.status_code == 429
    # Ліміт — на користувача, не спільний.
    ratelimit.check("user-b", 20)


def test_st_rate_limit_window_frees_after_60s(clock):
    for _ in range(20):
        ratelimit.check("user-a", 20)
    clock.now += 60          # рівно 60 с — ще в вікні (умова `> 60`)
    with pytest.raises(HTTPException):
        ratelimit.check("user-a", 20)
    clock.now += 0.001       # 60,001 с — найстаріший запит випав
    ratelimit.check("user-a", 20)


def _resp(n: int) -> ParseResponse:
    return ParseResponse(url=f"https://shop.pl/{n}", title=str(n))


def test_bva_cache_500_entries_then_oldest_evicted(clock):
    for n in range(500):
        clock.now += 0.001
        cache.put(f"https://shop.pl/{n}", _resp(n), ttl=900)
    assert len(cache._cache) == 500
    assert cache.get("https://shop.pl/0") is not None
    cache.put("https://shop.pl/500", _resp(500), ttl=900)
    assert len(cache._cache) == 500
    assert cache.get("https://shop.pl/0") is None, "найстаріший запис витіснено"
    assert cache.get("https://shop.pl/500") is not None


def test_st_cache_entry_lifecycle(clock):
    url = "https://Shop.pl/lampa/#opis"
    assert cache.get(url) is None                                   # немає
    cache.put(url, _resp(1), ttl=10)
    assert cache.get("https://shop.pl/lampa") is not None           # є (той самий ключ після нормалізації)
    clock.now += 9.999
    assert cache.get(url) is not None                               # ще є за мить до межі
    clock.now += 0.001
    assert cache.get(url) is None                                   # рівно TTL — протух
    assert cache._cache == {}                                       # і прибраний


# ═══════════════════════════════════════════════
# PW — розбір ціни попарно
# ═══════════════════════════════════════════════
# Параметри: роздільник розрядів (немає, пробіл, NBSP, крапка, кома) ×
# дріб (немає, кома, крапка) × валюта (перед, після, немає).
# Повний перебір — 45; покривний масив — 15 рядків, усі пари є (QA_REPORT.md).

PAIRWISE_PRICE = [
    ("none", "none", "before"), ("space", "comma", "after"), ("nbsp", "dot", "none"),
    ("dot", "comma", "before"), ("comma", "dot", "after"), ("none", "comma", "none"),
    ("space", "dot", "before"), ("nbsp", "none", "after"), ("dot", "none", "none"),
    ("comma", "none", "before"), ("none", "dot", "after"), ("space", "none", "none"),
    ("nbsp", "comma", "before"), ("dot", "dot", "after"), ("comma", "comma", "none"),
]
_GROUP = {"none": "", "space": " ", "nbsp": " ", "dot": ".", "comma": ","}


@pytest.mark.parametrize(("group", "frac", "cur"), PAIRWISE_PRICE)
def test_pw_price_formats(group, frac, cur):
    # Незручні пари (крапка-розряд із крапкою-дробом) — свідомо неоднозначні;
    # для них очікування — ціле число без дробу або None, але не інше число.
    sep = _GROUP[group]
    text = f"12{sep}345"
    if frac == "comma":
        text += ",67"
    elif frac == "dot":
        text += ".67"
    text = {"before": f"zł {text}", "after": f"{text} zł", "none": text}[cur]
    got = parse_price(text)
    want = 12345.67 if frac != "none" else 12345.0
    ambiguous = (group == "dot" and frac == "dot") or (group == "comma" and frac == "comma")
    if ambiguous:
        assert got in (want, None, 1234567.0), text
    else:
        assert got == want, text


def test_pw_array_is_pairwise_complete():
    values = [list(_GROUP), ["none", "comma", "dot"], ["before", "after", "none"]]
    for a in range(3):
        for b in range(a + 1, 3):
            for va in values[a]:
                for vb in values[b]:
                    assert any(r[a] == va and r[b] == vb for r in PAIRWISE_PRICE), (va, vb)


# ═══════════════════════════════════════════════
# EG — вгадування помилок
# ═══════════════════════════════════════════════

@pytest.mark.xfail(strict=True, reason="BUG-QA-18: один знак дробу читається як розряди — ціна ×10")
@pytest.mark.parametrize(("raw", "want"), [("49.9", 49.9), ("12,5 zł", 12.5), ("0.5", 0.5)])
def test_eg_price_with_one_decimal(raw, want):
    assert parse_price(raw) == want


@pytest.mark.xfail(strict=True, reason="BUG-QA-18: JSON-LD offers.price \"49.9\" дає 499")
def test_eg_jsonld_price_string_with_one_decimal():
    html = ('<script type="application/ld+json">{"@type":"Product","name":"Лампа",'
            '"offers":{"price":"49.9","priceCurrency":"PLN"}}</script>')
    assert extract(html, "https://shop.pl/lampa").price == 49.9


def _parse_with_page(monkeypatch, html: str):
    async def fake_fetch(url):
        return html

    monkeypatch.setattr(main, "fetch_html", fake_fetch)
    main.app.dependency_overrides[main.require_user] = lambda: "qa-user"
    cache._cache.clear()
    ratelimit._hits.clear()
    try:
        with TestClient(main.app, raise_server_exceptions=False) as client:
            return client.post("/parse", json={"url": "https://shop.pl/qa-infinity"})
    finally:
        main.app.dependency_overrides.clear()
        cache._cache.clear()


def test_eg_parse_endpoint_happy_path(monkeypatch):
    html = ('<script type="application/ld+json">{"@type":"Product","name":"Лампа",'
            '"offers":{"price":"49.90","priceCurrency":"PLN"}}</script>')
    res = _parse_with_page(monkeypatch, html)
    assert res.status_code == 200
    assert res.json()["price"] == 49.9


def _non_finite(monkeypatch, literal):
    html = ('<script type="application/ld+json">{"@type":"Product","name":"Лампа",'
            f'"offers":{{"price":{literal},"priceCurrency":"PLN"}}}}</script>')
    res = _parse_with_page(monkeypatch, html)
    assert res.status_code == 200
    assert res.json()["price"] is None


@pytest.mark.parametrize("literal", ["-Infinity", "NaN"])
def test_eg_jsonld_negative_or_nan_price(monkeypatch, literal):
    _non_finite(monkeypatch, literal)


@pytest.mark.xfail(strict=True, reason="BUG-QA-19: +Infinity у JSON-LD — 500 замість відповіді без ціни")
@pytest.mark.parametrize("literal", ["Infinity", "1e400"])
def test_eg_jsonld_infinite_price(monkeypatch, literal):
    _non_finite(monkeypatch, literal)


@pytest.mark.parametrize(
    "ip",
    ["127.0.0.1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "0.1.2.3", "198.18.0.1",
     "240.0.0.1", "255.255.255.255", "fe80::1", "fc00::1", "2002:7f00:1::1", "2001:db8::1"],
)
def test_eg_ssrf_obscure_private_forms_blocked(ip):
    assert fetcher._is_public(ip) is False, ip


@pytest.mark.xfail(strict=True, reason="BUG-QA-20: NAT64 і IPv4-сумісні IPv6 з приватною IPv4 вважаються публічними")
@pytest.mark.parametrize("ip", ["64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "::127.0.0.1", "::169.254.169.254"])
def test_eg_ssrf_embedded_ipv4_blocked(ip):
    embedded = ipaddress.IPv4Address(int(ipaddress.IPv6Address(ip)) & 0xFFFFFFFF)
    assert not embedded.is_global, "передумова: вбудована IPv4 — приватна"
    assert fetcher._is_public(ip) is False, ip

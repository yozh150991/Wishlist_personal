"""Malformed shop content must not turn an authenticated /parse request into 500.

Network and authentication are isolated at their boundaries; extraction, response
validation, cache, and HTTP status handling are the real production code.
Known defects use strict, assertion-only xfail (ADR-069), never broad exceptions.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app import cache, main, ratelimit
from app.auth import require_user
from app.config import Settings
from app.extract import parse_price


@pytest.fixture
def parser(monkeypatch):
    cache._cache.clear()
    cfg = Settings(parser_rate_limit_per_min=1000, _env_file=None)
    monkeypatch.setattr(main, "settings", lambda: cfg)
    monkeypatch.setattr(ratelimit, "check", lambda *_args: None)
    main.app.dependency_overrides[require_user] = lambda: "qa-resilience-user"
    document = {"html": "<title>Fallback lamp</title>"}
    calls = []

    async def fetch(url):
        calls.append(url)
        return document["html"]

    monkeypatch.setattr(main, "fetch_html", fetch)
    with TestClient(main.app, raise_server_exceptions=False) as client:
        yield client, document, calls
    main.app.dependency_overrides.pop(require_user, None)
    cache._cache.clear()


def markup(node):
    return '<script type="application/ld+json">' + json.dumps(node) + '</script><title>Fallback lamp</title>'


@pytest.mark.parametrize("node", [None, [], 42, "text", {"@type": "Organization"}])
def test_ep_non_product_jsonld_falls_back(parser, node):
    client, document, _ = parser
    document["html"] = markup(node)
    response = client.post("/parse", json={"url": "https://shop.example/lamp"})
    assert response.status_code == 200
    assert response.json()["title"] == "Fallback lamp"
    assert response.json()["partial"] is True


@pytest.mark.parametrize("node", [
    {"@type": 7},
    {"@type": True},
    {"@type": "Product", "name": {"text": "Lamp"}},
    {"@type": "Product", "name": ["Lamp"]},
    {"@type": "Product", "name": 123},
])
def test_eg_malformed_jsonld_fields_do_not_return_500(parser, node):
    client, document, _ = parser
    document["html"] = markup(node)
    response = client.post("/parse", json={"url": "https://shop.example/lamp"})
    assert response.status_code == 200, response.text
    assert response.json()["title"] == "Fallback lamp"


@pytest.mark.parametrize("digits", [309, 400])
def test_bva_oversized_json_integer_is_ignored_without_500(parser, digits):
    client, document, _ = parser
    document["html"] = markup({"@type": "Product", "name": "Lamp", "offers": {"price": int("9" * digits)}})
    response = client.post("/parse", json={"url": "https://shop.example/lamp"})
    assert response.status_code == 200, response.text
    assert response.json()["price"] is None
    assert response.json()["partial"] is True


@pytest.mark.parametrize("price", ["-5", "-0.01", "-49,90 zł"])
def test_ep_negative_text_is_not_a_positive_price(price):
    assert parse_price(price) is None


@pytest.mark.parametrize("price", [-5, -0.01, False, None, float("inf"), float("nan")])
def test_ep_invalid_numeric_price_is_absent(price):
    assert parse_price(price) is None


def test_st_cache_absent_hit_expired_refetched(parser, monkeypatch):
    client, document, calls = parser
    clock = [100.0]
    monkeypatch.setattr(cache.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(main, "settings", lambda: Settings(parser_cache_ttl_seconds=60, _env_file=None))
    url = "https://shop.example/lamp"
    document["html"] = '<title>First</title>'
    assert client.post('/parse', json={"url": url}).json()["title"] == 'First'
    document["html"] = '<title>Second</title>'
    clock[0] = 159.999
    assert client.post('/parse', json={"url": url}).json()["title"] == 'First'
    assert len(calls) == 1
    clock[0] = 160.0
    assert client.post('/parse', json={"url": url}).json()["title"] == 'Second'
    assert len(calls) == 2


def test_st_failed_fetch_is_not_cached_and_next_request_recovers(parser, monkeypatch):
    from fastapi import HTTPException

    client, _, _ = parser
    attempts = []

    async def flaky_fetch(url):
        attempts.append(url)
        if len(attempts) == 1:
            raise HTTPException(504, 'fetch_timeout')
        return '<title>Recovered</title>'

    monkeypatch.setattr(main, 'fetch_html', flaky_fetch)
    url = 'https://shop.example/recover'
    assert client.post('/parse', json={"url": url}).status_code == 504
    response = client.post('/parse', json={"url": url})
    assert response.status_code == 200
    assert response.json()['title'] == 'Recovered'
    assert len(attempts) == 2


def test_eg_product_variant_query_parameters_never_share_cached_price(parser):
    client, document, calls = parser
    for variant, price in [('small', 10), ('large', 100)]:
        document['html'] = markup({'@type': 'Product', 'name': variant, 'offers': {'price': price}})
        result = client.post('/parse', json={'url': f'https://shop.example/lamp?variant={variant}'})
        assert result.status_code == 200
        assert result.json()['price'] == price
    assert len(calls) == 2


# Межі виправлень BUG-QA-27…29 (ADR-071): що лишилось, як було.
@pytest.mark.parametrize(("raw", "want"), [
    ("−49,90 zł", None),        # типографський мінус — теж мінус
    ("od 49,90 - 59,90 zł", 49.9),   # діапазон: перше число без знака
    ("Model X-200 za 49,99 zł", 200.0),  # дефіс у коді товару — не мінус
    (9_999_999_999, 9_999_999_999.0),    # найбільша ціна, що лягає в numeric(12,2)
    (10_000_000_000, None),
    ("10 000 000 000 zł", None),
    ({"value": 10}, None),           # обʼєкт на місці ціни не стає цифрами з str()
    (["10"], None),
])
def test_bva_price_fix_boundaries(raw, want):
    assert parse_price(raw) == want


def test_eg_currency_object_is_not_guessed_from_its_repr():
    from app.extract import normalise_currency
    assert normalise_currency({"sign": "$"}) is None


def test_eg_availability_ignores_broken_type():
    from app.extract import availability
    assert availability(markup({"@type": 7, "offers": {"availability": "OutOfStock"}})) is None

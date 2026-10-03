"""
Закритий сервіс фонових задач wishlist-jobs (ADR-048): перевірка посилань.

Мережі тут немає: DNS і транспорт підмінено так само, як у test_fetch_pinning,
а базу заступає підмінний Store. Перевіряємо висновки (є / немає в наявності /
сторінки немає / нічого певного), чемність до магазинів і межу часу.
"""

import json
from datetime import datetime, timezone

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app import fetcher
from app.extract import availability
from app import jobs_links as links
from app.jobs_config import JobSettings, job_settings
from app.jobs_main import app
from app.jobs_store import Store, Target, Verdict

HTML = {"content-type": "text/html; charset=utf-8"}


def fake_dns(monkeypatch, mapping: dict[str, list[str]]):
    def getaddrinfo(host, *_args, **_kwargs):
        addresses = mapping.get(host)
        if addresses is None:
            raise OSError(f"немає запису для {host}")
        return [(2, 1, 6, "", (ip, 0)) for ip in addresses]

    monkeypatch.setattr(fetcher.socket, "getaddrinfo", getaddrinfo)


def product(price: str, availability_url: str | None = None) -> str:
    offer: dict[str, object] = {"@type": "Offer", "price": price, "priceCurrency": "UAH"}
    if availability_url:
        offer["availability"] = availability_url
    data = {"@context": "https://schema.org", "@type": "Product", "name": "Лампа", "offers": offer}
    return f'<html><head><script type="application/ld+json">{json.dumps(data)}</script></head></html>'


def fetch_via(handler):
    transport = httpx.MockTransport(handler)
    return lambda url: fetcher.fetch_html(url, transport=transport)


class TestAvailability:
    def test_json_ld_in_stock_and_out_of_stock(self):
        assert availability(product("10", "https://schema.org/InStock")) is True
        assert availability(product("10", "https://schema.org/OutOfStock")) is False
        assert availability(product("10", "http://schema.org/Discontinued")) is False

    def test_any_offer_in_stock_means_available(self):
        data = {
            "@type": "Product",
            "offers": [
                {"availability": "https://schema.org/OutOfStock"},
                {"availability": "https://schema.org/InStock"},
            ],
        }
        html = f'<script type="application/ld+json">{json.dumps(data)}</script>'
        assert availability(html) is True

    def test_microdata_and_meta(self):
        assert availability('<link itemprop="availability" href="https://schema.org/SoldOut">') is False
        assert availability('<meta property="product:availability" content="out of stock">') is False
        assert availability('<meta property="og:availability" content="instock">') is True

    def test_silent_page_says_nothing(self):
        assert availability("<html><title>Лампа</title></html>") is None
        assert availability(product("10")) is None


class TestCheckOne:
    async def test_page_with_price_is_ok(self, monkeypatch):
        fake_dns(monkeypatch, {"shop.example": ["93.184.216.34"]})
        fetch = fetch_via(lambda r: httpx.Response(200, headers=HTML, text=product("1 390,00")))
        assert await links.check_one("https://shop.example/lampa", fetch) == Verdict("ok", 1390.0, "UAH")

    async def test_out_of_stock_keeps_the_price(self, monkeypatch):
        fake_dns(monkeypatch, {"shop.example": ["93.184.216.34"]})
        fetch = fetch_via(
            lambda r: httpx.Response(200, headers=HTML, text=product("899", "https://schema.org/OutOfStock"))
        )
        assert await links.check_one("https://shop.example/lampa", fetch) == Verdict("out", 899.0, "UAH")

    @pytest.mark.parametrize("code", [404, 410])
    async def test_missing_page_is_gone(self, monkeypatch, code):
        fake_dns(monkeypatch, {"shop.example": ["93.184.216.34"]})
        fetch = fetch_via(lambda r: httpx.Response(code, headers=HTML, text="nope"))
        assert await links.check_one("https://shop.example/lampa", fetch) == Verdict("gone")

    @pytest.mark.parametrize("code", [403, 429, 500, 503])
    async def test_bot_wall_or_outage_says_nothing(self, monkeypatch, code):
        fake_dns(monkeypatch, {"shop.example": ["93.184.216.34"]})
        fetch = fetch_via(lambda r: httpx.Response(code, headers=HTML, text="nope"))
        assert await links.check_one("https://shop.example/lampa", fetch) == Verdict(None)

    async def test_private_address_is_not_fetched_and_says_nothing(self, monkeypatch):
        fake_dns(monkeypatch, {"evil.example": ["169.254.169.254"]})
        called = False

        def handler(request):
            nonlocal called
            called = True
            return httpx.Response(200, headers=HTML, text="secret")

        assert await links.check_one("https://evil.example/", fetch_via(handler)) == Verdict(None)
        assert called is False


class FakeStore:
    def __init__(self, targets: list[Target]):
        self.queue = list(targets)
        self.saved: list[tuple[Target, Verdict]] = []

    async def due(self, limit, checked_before):
        out, self.queue = self.queue[:limit], self.queue[limit:]
        return out

    async def save(self, target, verdict, checked_at):
        self.saved.append((target, verdict))


class TestRun:
    async def test_checks_everything_due_and_counts(self):
        store = FakeStore([Target("1", "https://a.example/1"), Target("2", "https://b.example/2")])
        verdicts = {"https://a.example/1": Verdict("ok", 10.0, "PLN"), "https://b.example/2": Verdict("gone")}

        async def check(url, fetch):
            return verdicts[url]

        slept: list[float] = []

        async def sleep(s):
            slept.append(s)

        summary = await links.run(
            store, batch=10, budget_seconds=60, recheck_hours=20, host_delay=2, concurrency=4, check=check, sleep=sleep
        )

        assert summary == {"ok": 1, "gone": 1, "checked": 2}
        assert {t.id for t, _ in store.saved} == {"1", "2"}
        assert slept == []  # різні хости — без пауз

    async def test_same_host_one_by_one_with_pause(self):
        store = FakeStore([Target(str(i), f"https://shop.example/{i}") for i in range(3)])
        order: list[str] = []

        async def check(url, fetch):
            order.append(url)
            return Verdict(None)

        slept: list[float] = []

        async def sleep(s):
            slept.append(s)

        summary = await links.run(
            store, batch=10, budget_seconds=60, recheck_hours=20, host_delay=2, concurrency=4, check=check, sleep=sleep
        )

        assert order == [f"https://shop.example/{i}" for i in range(3)]
        assert slept == [2, 2]
        assert summary == {"kept": 3, "checked": 3}

    async def test_time_budget_defers_the_rest(self):
        store = FakeStore([Target(str(i), f"https://shop.example/{i}") for i in range(5)])
        now = [0.0]

        async def check(url, fetch):
            now[0] += 10
            return Verdict("ok")

        async def sleep(s):
            return None

        summary = await links.run(
            store,
            batch=10,
            budget_seconds=25,
            recheck_hours=20,
            host_delay=0,
            concurrency=1,
            check=check,
            clock=lambda: now[0],
            sleep=sleep,
        )

        assert summary == {"ok": 3, "deferred": 2, "checked": 3}
        assert len(store.saved) == 3


class TestStore:
    @respx.mock
    async def test_due_asks_only_what_is_needed_with_the_secret_key_only_in_apikey(self):
        route = respx.get("https://ref.supabase.co/rest/v1/items").mock(
            return_value=httpx.Response(200, json=[{"id": "1", "url": "https://shop.example/1", "lists": {}}])
        )
        async with httpx.AsyncClient() as client:
            store = Store("https://ref.supabase.co", "sb_secret_test", client)
            got = await store.due(5, datetime(2026, 9, 28, tzinfo=timezone.utc))

        assert got == [Target("1", "https://shop.example/1")]
        request = route.calls.last.request
        assert request.headers["apikey"] == "sb_secret_test"
        assert "authorization" not in request.headers
        params = dict(request.url.params)
        assert params["status"] == "eq.active"
        assert params["lists.is_archived"] == "is.false"
        assert params["url"] == "not.is.null"
        assert params["limit"] == "5"
        assert "link_checked_at.lt.2026-09-28" in params["or"]

    @respx.mock
    async def test_save_writes_only_link_fields(self):
        route = respx.patch("https://ref.supabase.co/rest/v1/items").mock(return_value=httpx.Response(204))
        checked = datetime(2026, 9, 29, 4, 0, tzinfo=timezone.utc)
        async with httpx.AsyncClient() as client:
            store = Store("https://ref.supabase.co", "sb_secret_test", client)
            await store.save(Target("1", "u"), Verdict("ok", 1390.0, "UAH"), checked)
            await store.save(Target("2", "u"), Verdict("gone"), checked)
            await store.save(Target("3", "u"), Verdict(None), checked)

        bodies = [json.loads(call.request.content) for call in route.calls]
        assert bodies[0] == {
            "link_checked_at": checked.isoformat(),
            "link_status": "ok",
            "link_price": 1390.0,
            "link_currency": "UAH",
        }
        # Сторінки немає — ціну з минулої перевірки не стираємо.
        assert bodies[1] == {"link_checked_at": checked.isoformat(), "link_status": "gone"}
        # Нічого певного — лише час: позиція стає в кінець черги.
        assert bodies[2] == {"link_checked_at": checked.isoformat()}
        assert [dict(c.request.url.params)["id"] for c in route.calls] == ["eq.1", "eq.2", "eq.3"]


class TestApp:
    def test_job_without_token_is_refused(self):
        with TestClient(app) as client:
            assert client.post("/jobs/check-links").status_code == 401

    def test_job_without_configuration_is_503(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://ref.supabase.co")
        monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_publishable_wrong_key")
        job_settings.cache_clear()
        try:
            with TestClient(app) as client:
                res = client.post("/jobs/check-links", headers={"Authorization": "Bearer " + "x" * 40})
            assert res.status_code == 503
            assert res.json()["detail"] == "jobs_not_configured"
        finally:
            job_settings.cache_clear()

    def test_settings_strip_a_trailing_newline_from_the_secret(self):
        cfg = JobSettings(supabase_url=" https://r.supabase.co\n", supabase_secret_key="sb_secret_x\r\n")
        assert cfg.supabase_secret_key == "sb_secret_x"
        assert cfg.ready

    def test_settings_accept_only_a_secret_key(self):
        assert JobSettings(supabase_url="https://r.supabase.co", supabase_secret_key="sb_secret_x").ready
        assert not JobSettings(supabase_url="https://r.supabase.co", supabase_secret_key="sb_publishable_x").ready
        assert not JobSettings(supabase_url="https://<ref>.supabase.co", supabase_secret_key="sb_secret_x").ready

    def test_settings_strip_a_bom_from_the_secret(self):
        cfg = JobSettings(supabase_url="https://r.supabase.co", supabase_secret_key="\ufeffsb_secret_x\r\n")
        assert cfg.supabase_secret_key == "sb_secret_x"
        assert cfg.ready

    def test_health_names_what_is_missing_without_values(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://<project-ref>.supabase.co")
        monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_publishable_wrong_key")
        job_settings.cache_clear()
        try:
            with TestClient(app) as client:
                body = client.get("/health").json()
            assert body["configured"] is False
            assert body["problems"] == ["SUPABASE_URL", "SUPABASE_SECRET_KEY"]
            assert "sb_publishable" not in json.dumps(body)
        finally:
            job_settings.cache_clear()

    def test_run_summary_reaches_the_log_but_shop_addresses_do_not(self):
        import logging

        jobs_log = logging.getLogger("jobs")
        assert jobs_log.handlers and not jobs_log.propagate
        assert logging.getLogger("jobs.links").isEnabledFor(logging.INFO)
        # httpx на INFO пише кожну адресу запиту — лишається тихим.
        assert not logging.getLogger("httpx").isEnabledFor(logging.INFO)

    def test_public_parser_does_not_ship_the_jobs_app(self):
        from app import main as parser_main

        paths = {getattr(r, "path", "") for r in parser_main.app.routes}
        assert "/jobs/check-links" not in paths

    def test_public_parser_reports_a_misplaced_secret_key(self, monkeypatch):
        from app import main as parser_main

        monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_oops")
        with TestClient(parser_main.app) as client:
            assert client.get("/health").json()["secret_key_present"] is True
        monkeypatch.delenv("SUPABASE_SECRET_KEY")
        with TestClient(parser_main.app) as client:
            assert client.get("/health").json()["secret_key_present"] is False

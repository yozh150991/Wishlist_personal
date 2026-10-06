"""
Курс НБП для підказки «≈» (ADR-051). Мережі немає: НБП і PostgREST
підмінено respx. Перевіряємо розбір таблиці A, запис по рядку на валюту і те,
що збій НБП не валить щоденну перевірку посилань.
"""

from datetime import date
from decimal import Decimal

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app import jobs_rates as rates
from app.jobs_config import job_settings
from app.jobs_main import app
from app.jobs_store import Store

TABLE = [
    {
        "table": "A",
        "no": "193/A/NBP/2026",
        "effectiveDate": "2026-10-05",
        "rates": [
            {"currency": "euro", "code": "EUR", "mid": 4.2765},
            {"currency": "dolar amerykański", "code": "USD", "mid": 3.6512},
            {"currency": "hrywna (Ukraina)", "code": "UAH", "mid": 0.0881},
            {"currency": "funt szterling", "code": "GBP", "mid": 4.9},
        ],
    }
]


class TestParse:
    def test_takes_only_our_currencies_with_the_table_date(self):
        got = rates.parse_table(TABLE)
        assert [(r.currency, r.pln_per_unit, r.rate_date) for r in got] == [
            ("EUR", Decimal("4.2765"), date(2026, 10, 5)),
            ("USD", Decimal("3.6512"), date(2026, 10, 5)),
            ("UAH", Decimal("0.0881"), date(2026, 10, 5)),
        ]

    def test_broken_rows_are_skipped_not_fatal(self):
        table = [{"effectiveDate": "2026-10-05", "rates": [{"code": "EUR", "mid": "x"}, {"code": "USD", "mid": 0}, "?"]}]
        assert rates.parse_table(table) == []

    @pytest.mark.parametrize("payload", [{}, [], ["x"], [{"effectiveDate": "вчора", "rates": []}]])
    def test_unexpected_payload_is_an_error(self, payload):
        with pytest.raises(ValueError):
            rates.parse_table(payload)


class TestRefresh:
    @respx.mock
    async def test_saves_one_row_per_currency_as_upsert(self):
        respx.get(rates.NBP_TABLE_A).respond(json=TABLE)
        route = respx.post("https://ref.supabase.co/rest/v1/fx_rates").respond(201)
        async with httpx.AsyncClient() as client:
            n = await rates.refresh(Store("https://ref.supabase.co", "sb_secret_x", client), client)
        assert n == 3
        req = route.calls[0].request
        assert req.url.params["on_conflict"] == "currency"
        assert "merge-duplicates" in req.headers["prefer"]
        import json

        body = json.loads(req.content)
        assert [(r["currency"], r["pln_per_unit"], r["rate_date"]) for r in body] == [
            ("EUR", "4.2765", "2026-10-05"),
            ("USD", "3.6512", "2026-10-05"),
            ("UAH", "0.0881", "2026-10-05"),
        ]

    @respx.mock
    async def test_nbp_down_writes_nothing_and_does_not_raise(self):
        respx.get(rates.NBP_TABLE_A).respond(503)
        route = respx.post("https://ref.supabase.co/rest/v1/fx_rates").respond(201)
        async with httpx.AsyncClient() as client:
            assert await rates.refresh(Store("https://ref.supabase.co", "sb_secret_x", client), client) == 0
        assert not route.called


class TestDailyJob:
    @respx.mock
    def test_check_links_refreshes_rates_and_survives_nbp_failure(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://ref.supabase.co")
        monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_x")
        monkeypatch.setenv("JOBS_TIME_BUDGET_SECONDS", "1")
        job_settings.cache_clear()
        respx.get(rates.NBP_TABLE_A).mock(side_effect=httpx.ConnectError("down"))
        respx.get("https://ref.supabase.co/rest/v1/items").respond(json=[])
        try:
            with TestClient(app) as client:
                res = client.post("/jobs/check-links", headers={"Authorization": "Bearer " + "x" * 40})
            assert res.status_code == 200
            assert res.json()["fx_rates"] == 0
        finally:
            job_settings.cache_clear()

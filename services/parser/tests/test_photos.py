"""
Прибирання своїх фото позицій (ADR-073). Мережі немає: PostgREST і сховище
Supabase підмінено respx. Перевіряємо порядок (спершу файли, потім рядки),
те, що збій сховища не забуває адрес, і що щоденна задача переживає збій.
"""

import json

import httpx
import respx
from fastapi.testclient import TestClient

from app import jobs_photos as photos
from app import jobs_rates as rates
from app.jobs_config import job_settings
from app.jobs_main import app
from app.jobs_store import Store

BASE = "https://ref.supabase.co"
A = "0123456789abcdef0123456789abcdef.webp"
B = "fedcba9876543210fedcba9876543210.jpg"


class TestSweep:
    @respx.mock
    async def test_removes_files_then_forgets_their_rows(self):
        orphans = respx.post(f"{BASE}/rest/v1/rpc/item_photo_orphans").respond(json=[A, B])
        remove = respx.delete(f"{BASE}/storage/v1/object/item-photos").respond(json=[{"name": A}])
        forget = respx.post(f"{BASE}/rest/v1/rpc/forget_item_photos").respond(204)
        async with httpx.AsyncClient() as client:
            n = await photos.sweep(Store(BASE, "sb_secret_x", client), limit=50)

        assert n == 2
        assert json.loads(orphans.calls[0].request.content) == {"p_limit": 50}
        assert json.loads(remove.calls[0].request.content) == {"prefixes": [A, B]}
        # Файлу B у сховищі вже не було — рядок однаково забувається.
        assert json.loads(forget.calls[0].request.content) == {"p_paths": [A, B]}
        # Ключ — лише в apikey: новий secret-ключ не JWT (ADR-013).
        assert remove.calls[0].request.headers["apikey"] == "sb_secret_x"
        assert "authorization" not in remove.calls[0].request.headers

    @respx.mock
    async def test_nothing_to_sweep_touches_nothing(self):
        respx.post(f"{BASE}/rest/v1/rpc/item_photo_orphans").respond(json=[])
        remove = respx.delete(f"{BASE}/storage/v1/object/item-photos").respond(200, json=[])
        forget = respx.post(f"{BASE}/rest/v1/rpc/forget_item_photos").respond(204)
        async with httpx.AsyncClient() as client:
            assert await photos.sweep(Store(BASE, "sb_secret_x", client)) == 0
        assert not remove.called
        assert not forget.called

    @respx.mock
    async def test_storage_failure_keeps_rows_for_tomorrow(self):
        respx.post(f"{BASE}/rest/v1/rpc/item_photo_orphans").respond(json=[A])
        respx.delete(f"{BASE}/storage/v1/object/item-photos").respond(503)
        forget = respx.post(f"{BASE}/rest/v1/rpc/forget_item_photos").respond(204)
        async with httpx.AsyncClient() as client:
            try:
                await photos.sweep(Store(BASE, "sb_secret_x", client))
                raised = False
            except httpx.HTTPStatusError:
                raised = True
        assert raised
        assert not forget.called

    @respx.mock
    async def test_junk_in_orphans_answer_is_ignored(self):
        respx.post(f"{BASE}/rest/v1/rpc/item_photo_orphans").respond(json=[A, 42, None, {"path": B}])
        remove = respx.delete(f"{BASE}/storage/v1/object/item-photos").respond(200, json=[])
        respx.post(f"{BASE}/rest/v1/rpc/forget_item_photos").respond(204)
        async with httpx.AsyncClient() as client:
            assert await photos.sweep(Store(BASE, "sb_secret_x", client)) == 1
        assert json.loads(remove.calls[0].request.content) == {"prefixes": [A]}


class TestDailyJob:
    @respx.mock
    def test_check_links_sweeps_photos_and_survives_storage_failure(self, monkeypatch, caplog):
        monkeypatch.setenv("SUPABASE_URL", BASE)
        monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_x")
        monkeypatch.setenv("JOBS_TIME_BUDGET_SECONDS", "1")
        job_settings.cache_clear()
        respx.get(rates.NBP_TABLE_A).mock(side_effect=httpx.ConnectError("down"))
        respx.post(f"{BASE}/rest/v1/rpc/item_photo_orphans").respond(json=[A])
        respx.delete(f"{BASE}/storage/v1/object/item-photos").mock(side_effect=httpx.ConnectError("down"))
        respx.get(f"{BASE}/rest/v1/items").respond(json=[])
        try:
            with TestClient(app) as client:
                res = client.post("/jobs/check-links", headers={"Authorization": "Bearer " + "x" * 40})
            assert res.status_code == 200
            assert res.json()["photos_removed"] == 0
            # Адреса фото — доступ до нього: у журналі її немає.
            assert A not in caplog.text
        finally:
            job_settings.cache_clear()

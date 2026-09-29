"""
Закритий сервіс фонових задач wishlist-jobs (ADR-048).

Той самий образ, що й парсер, але інший застосунок (`APP_MODULE=app.jobs_main:app`)
і інший сервіс Cloud Run: викликати його може лише Cloud Scheduler, і лише він
тримає secret-ключ Supabase. Відкритий парсер (`app.main`) модулів `jobs_*`
не імпортує.
"""

import logging

import httpx
from fastapi import FastAPI, HTTPException, Request, status

from . import jobs_links as links
from .jobs_config import job_settings
from .jobs_store import Store

log = logging.getLogger("jobs")

app = FastAPI(title="Wishlist jobs", version="0.1.0", docs_url=None, redoc_url=None)


def _require_invoker(request: Request) -> None:
    """
    Справжній захист — IAM Cloud Run (`--no-allow-unauthenticated`): до
    контейнера доходять лише запити з ID-токеном облікового запису, якому
    дали `roles/run.invoker`, тобто Cloud Scheduler. Тут — друга лінія на
    випадок, якщо сервіс колись розгорнуть відкритим: без токена — відмова.
    """
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer ") or len(header) < 20:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing_token")


@app.get("/health")
async def health() -> dict[str, object]:
    # Лише назви змінних, яких бракує, — без значень. /health теж за IAM.
    cfg = job_settings()
    return {"status": "ok", "service": "wishlist-jobs", "configured": cfg.ready, "problems": cfg.problems}


@app.post("/jobs/check-links")
async def check_links(request: Request) -> dict[str, int]:
    _require_invoker(request)
    cfg = job_settings()
    if not cfg.ready:
        log.error("SUPABASE_URL або SUPABASE_SECRET_KEY не задано (ключ має починатись з sb_secret_)")
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "jobs_not_configured")
    async with httpx.AsyncClient(timeout=15.0) as client:
        store = Store(cfg.supabase_url, cfg.supabase_secret_key, client)
        return await links.run(
            store,
            batch=cfg.jobs_batch_size,
            budget_seconds=cfg.jobs_time_budget_seconds,
            recheck_hours=cfg.jobs_recheck_hours,
            host_delay=cfg.jobs_host_delay_seconds,
            concurrency=cfg.jobs_concurrency,
        )

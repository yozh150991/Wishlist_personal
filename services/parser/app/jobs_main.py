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
from . import jobs_notify as notify
from . import jobs_rates as rates
from .jobs_config import job_settings
from .jobs_mail import Mailer
from .jobs_push import Pusher
from .jobs_store import NotifyStore, Store

log = logging.getLogger("jobs")


def _log_counts_at_info() -> None:
    """
    Uvicorn налаштовує лише свої журнали, тож `log.info` задач ішов у нікуди,
    і підсумок запуску в журналі Cloud Run не було видно. Обробник — лише для
    журналу `jobs` (і `jobs.links`, `jobs.store` під ним), а не для кореня:
    `httpx` на рівні INFO писав би кожну адресу магазину, а в журнал задач
    ідуть тільки лічильники (ADR-048).
    """
    if log.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s: %(name)s %(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False


_log_counts_at_info()

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
    brevo = "not_configured"
    if "BREVO_API_KEY" not in cfg.notify_problems:
        # Живий виклик: заодно рахується Brevo як успішне використання ключа.
        async with httpx.AsyncClient(timeout=5.0) as client:
            brevo = await Mailer(cfg.brevo_api_key, cfg.mail_from, client).ping()
    return {
        "status": "ok",
        "service": "wishlist-jobs",
        "configured": cfg.ready,
        "problems": cfg.problems,
        "notify_configured": cfg.notify_ready,
        "notify_problems": cfg.notify_problems,
        "brevo": brevo,
    }


@app.post("/jobs/check-links")
async def check_links(request: Request) -> dict[str, int]:
    _require_invoker(request)
    cfg = job_settings()
    if not cfg.ready:
        log.error("SUPABASE_URL або SUPABASE_SECRET_KEY не задано (ключ має починатись з sb_secret_)")
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "jobs_not_configured")
    async with httpx.AsyncClient(timeout=15.0) as client:
        store = Store(cfg.supabase_url, cfg.supabase_secret_key, client)
        # Курс НБП — тим самим щоденним викликом (ADR-051): без третьої задачі
        # Cloud Scheduler. Збій курсу перевірку посилань не зупиняє.
        fx = await rates.refresh(store, client)
        summary = await links.run(
            store,
            batch=cfg.jobs_batch_size,
            budget_seconds=cfg.jobs_time_budget_seconds,
            recheck_hours=cfg.jobs_recheck_hours,
            host_delay=cfg.jobs_host_delay_seconds,
            concurrency=cfg.jobs_concurrency,
        )
        return {**summary, "fx_rates": fx}


@app.post("/jobs/notify")
async def send_notifications(request: Request) -> dict[str, int]:
    """Сповіщення власника (ADR-049): раз на годину з Cloud Scheduler."""
    _require_invoker(request)
    cfg = job_settings()
    if not cfg.notify_ready:
        log.error("Сповіщенням бракує налаштувань: %s", ", ".join(cfg.problems + cfg.notify_problems))
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "notify_not_configured")
    async with httpx.AsyncClient(timeout=15.0) as client:
        return await notify.run(
            NotifyStore(cfg.supabase_url, cfg.supabase_secret_key, client),
            Pusher(cfg.vapid_private_key, cfg.mail_from, client),
            Mailer(cfg.brevo_api_key, cfg.mail_from, client),
            origin=cfg.app_origin.rstrip("/"),
        )

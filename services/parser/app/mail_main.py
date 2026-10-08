"""
Відкритий сервіс гостьових листів wishlist-guestmail (ADR-054).

Той самий образ, що й парсер і wishlist-jobs, інший застосунок
(`APP_MODULE=app.mail_main:app`) і інший сервіс Cloud Run — відкритий, бо
pg_net у базі не має Google ID-токена, яким закрито wishlist-jobs.

Відкритий — не означає беззахисний:
- приймає лише `POST /wake` із секретом у заголовку `x-wake-secret`
  (порівняння постійного часу), той самий секрет лежить у Supabase Vault;
- запит не несе даних: що й кому писати, сервіс читає з черги сам, тож навіть
  витеклий секрет дає лише зайву обробку тієї самої черги;
- одночасно черга обробляється один раз: другий сигнал, що прийшов під час
  обробки, отримує `busy` і нічого не робить.
Модулі jobs_* (перевірка посилань, сповіщення власника) тут не імпортуються.
"""

import asyncio
import hmac
import logging
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, HTTPException, Request, status

from . import guest_mail
from .jobs_config import job_settings
from .jobs_mail import Mailer

log = logging.getLogger("jobs.guestmail")


def _log_counts_at_info() -> None:
    """Лише лічильники в журнал Cloud Run, як у wishlist-jobs; httpx лишається тихим."""
    root = logging.getLogger("jobs")
    if root.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s: %(name)s %(message)s"))
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    root.propagate = False


_log_counts_at_info()

app = FastAPI(title="Wishlist guest mail", version="0.1.0", docs_url=None, redoc_url=None, openapi_url=None)

_lock = asyncio.Lock()


def _check_secret(request: Request, expected: str) -> None:
    given = request.headers.get("x-wake-secret", "")
    if not expected or not hmac.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad_secret")


@app.get("/health")
async def health() -> dict[str, object]:
    # Відкритий сервіс: лише чи налаштовано, без назв змінних.
    return {"status": "ok", "service": "wishlist-guestmail", "configured": job_settings().guest_mail_ready}


@app.post("/wake")
async def wake(request: Request) -> dict[str, int]:
    cfg = job_settings()
    _check_secret(request, cfg.guest_mail_wake_secret)
    if not cfg.guest_mail_ready:
        log.error("Гостьовим листам бракує налаштувань: %s", ", ".join(cfg.problems + cfg.guest_mail_problems))
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "guest_mail_not_configured")
    if _lock.locked():
        return {"busy": 1}
    async with _lock:
        async with httpx.AsyncClient(timeout=15.0) as client:
            return await guest_mail.process(
                guest_mail.GuestMailStore(cfg.supabase_url, cfg.supabase_secret_key, client),
                Mailer(cfg.brevo_api_key, cfg.mail_from, client),
                origin=cfg.app_origin,
                now=datetime.now(timezone.utc),
            )

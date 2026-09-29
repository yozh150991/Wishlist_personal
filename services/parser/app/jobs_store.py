"""
Доступ сервісу wishlist-jobs до бази — PostgREST із secret-ключем (ADR-048).

Secret-ключ дає роль service_role, яка обходить RLS, тож усе, що тут
пишеться, має бути вузьким: лише поля перевірки посилань, лише за `id`.
Позначок гостей (`claims`, `guest_*`) цей модуль не торкається й не повинен.
"""

import logging
from dataclasses import dataclass
from datetime import datetime

import httpx

log = logging.getLogger("jobs.store")


@dataclass(frozen=True)
class Target:
    id: str
    url: str


@dataclass(frozen=True)
class Verdict:
    """
    Що побачила перевірка. `status=None` — нічого певного (магазин відмовив
    ботові, сервер ліг, DNS не відповів): лишаємо попередній висновок і лише
    відмічаємо час, щоб позиція стала в кінець черги.
    """

    status: str | None
    price: float | None = None
    currency: str | None = None


class Store:
    def __init__(self, supabase_url: str, secret_key: str, client: httpx.AsyncClient):
        self._base = f"{supabase_url.rstrip('/')}/rest/v1"
        # Нові ключі Supabase (`sb_secret_…`) — не JWT: вони йдуть лише в
        # заголовку `apikey`, без `Authorization: Bearer` (ADR-013).
        self._headers = {"apikey": secret_key}
        self._client = client

    async def due(self, limit: int, checked_before: datetime) -> list[Target]:
        """
        Позиції, які пора перевірити: з посиланням, актуальні, у неархівних
        списках, давно не перевірені — найдавніші першими.
        """
        res = await self._client.get(
            f"{self._base}/items",
            headers=self._headers,
            params={
                "select": "id,url,lists!inner(is_archived)",
                "url": "not.is.null",
                "status": "eq.active",
                "lists.is_archived": "is.false",
                "or": f"(link_checked_at.is.null,link_checked_at.lt.{checked_before.isoformat()})",
                "order": "link_checked_at.asc.nullsfirst",
                "limit": str(limit),
            },
        )
        if res.status_code in (401, 403):
            # Найчастіша причина — не той ключ: publishable замість secret.
            log.error("PostgREST відхилив ключ (%s): перевір SUPABASE_SECRET_KEY", res.status_code)
        res.raise_for_status()
        return [Target(id=row["id"], url=row["url"]) for row in res.json()]

    async def save(self, target: Target, verdict: Verdict, checked_at: datetime) -> None:
        body: dict[str, object] = {"link_checked_at": checked_at.isoformat()}
        if verdict.status is not None:
            body["link_status"] = verdict.status
            if verdict.status in ("ok", "out"):
                body["link_price"] = verdict.price
                body["link_currency"] = verdict.currency
        res = await self._client.patch(
            f"{self._base}/items",
            headers={**self._headers, "Prefer": "return=minimal"},
            params={"id": f"eq.{target.id}"},
            json=body,
        )
        res.raise_for_status()

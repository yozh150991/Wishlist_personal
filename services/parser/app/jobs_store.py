"""
Доступ сервісу wishlist-jobs до бази — PostgREST із secret-ключем (ADR-048).

Secret-ключ дає роль service_role, яка обходить RLS, тож усе, що тут
пишеться, має бути вузьким:
- перевірка посилань — лише поля `items.link_*` за `id`;
- курс НБП (ADR-051) — лише таблиця `fx_rates`, по рядку на валюту;
- сповіщення (ADR-049) — журнал надісланого, час останнього надсилання й
  прибирання мертвих підписок push;
- свої фото позицій (ADR-073) — лише сироти з `item_photo_orphans`: файл зі
  сховища `item-photos` і його рядок через `forget_item_photos`.
Позначок гостей (`claims`, `guest_*`) цей модуль не торкається й не повинен.
Токенів посилань теж не читає: з `shares` — лише назва й термін.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from .jobs_push import Subscription
from .jobs_rates import Rate

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
        self._storage = f"{supabase_url.rstrip('/')}/storage/v1"
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

    async def save_rates(self, rates: list[Rate]) -> None:
        """Курс НБП (ADR-051): по рядку на валюту, новий замінює вчорашній."""
        res = await self._client.post(
            f"{self._base}/fx_rates",
            headers={**self._headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
            params={"on_conflict": "currency"},
            json=[
                {
                    "currency": r.currency,
                    "pln_per_unit": str(r.pln_per_unit),
                    "rate_date": r.rate_date.isoformat(),
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                }
                for r in rates
            ],
        )
        res.raise_for_status()

    async def photo_orphans(self, limit: int) -> list[str]:
        """Свої фото без жодної позиції, що на них посилається (ADR-073)."""
        res = await self._client.post(
            f"{self._base}/rpc/item_photo_orphans", headers=self._headers, json={"p_limit": limit}
        )
        res.raise_for_status()
        rows = res.json()
        return [r for r in rows if isinstance(r, str)] if isinstance(rows, list) else []

    async def remove_photos(self, paths: list[str]) -> None:
        """Файли зі сховища. Відсутній файл — не помилка: сховище його просто пропускає."""
        res = await self._client.request(
            "DELETE",
            f"{self._storage}/object/item-photos",
            headers=self._headers,
            json={"prefixes": paths},
        )
        res.raise_for_status()

    async def forget_photos(self, paths: list[str]) -> None:
        res = await self._client.post(
            f"{self._base}/rpc/forget_item_photos", headers=self._headers, json={"p_paths": paths}
        )
        res.raise_for_status()


# ─────────────────────────────────────────────
# Сповіщення (ADR-049)
# ─────────────────────────────────────────────

KINDS = ("after_event", "yearly", "link", "price", "share")


@dataclass(frozen=True)
class Owner:
    """Власник, який щось увімкнув: подія → (push, пошта)."""

    id: str
    time_zone: str
    prefs: dict[str, tuple[bool, bool]]
    last_sent_at: datetime | None

    def wants(self, kind: str) -> bool:
        push, email = self.prefs.get(kind, (False, False))
        return push or email


@dataclass(frozen=True)
class SignInPrefs:
    """Канали листа про вхід із нового пристрою (ADR-074). Немає рядка — лист так."""

    push: bool = False
    email: bool = True
    time_zone: str = "UTC"


@dataclass(frozen=True)
class Recipient:
    """Кому писати: підтверджена пошта (або None) і мова інтерфейсу."""

    email: str | None
    locale: str | None


def _when(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class NotifyStore:
    def __init__(self, supabase_url: str, secret_key: str, client: httpx.AsyncClient):
        self._root = supabase_url.rstrip("/")
        self._base = f"{self._root}/rest/v1"
        self._headers = {"apikey": secret_key}
        self._client = client

    async def _get(self, table: str, params: list[tuple[str, str]]) -> list[dict]:
        res = await self._client.get(f"{self._base}/{table}", headers=self._headers, params=params)
        if res.status_code in (401, 403):
            log.error("PostgREST відхилив ключ (%s): перевір SUPABASE_SECRET_KEY", res.status_code)
        res.raise_for_status()
        return res.json()

    async def owners(self) -> list[Owner]:
        """Лише ті, хто ввімкнув хоч один канал: решта — поведінка v1, тиша."""
        any_on = ",".join(f"{k}_{c}.is.true" for k in KINDS for c in ("push", "email"))
        rows = await self._get(
            "notification_settings", [("select", "*"), ("or", f"({any_on})"), ("order", "owner_id.asc")]
        )
        return [
            Owner(
                id=row["owner_id"],
                time_zone=row.get("time_zone") or "UTC",
                prefs={k: (bool(row.get(f"{k}_push")), bool(row.get(f"{k}_email"))) for k in KINDS},
                last_sent_at=_when(row.get("last_sent_at")),
            )
            for row in rows
        ]

    async def lists(self, owner_id: str) -> list[dict]:
        return await self._get(
            "lists",
            [("select", "id,title,currency,event_date,is_archived,repeats_yearly"), ("owner_id", f"eq.{owner_id}")],
        )

    async def items(self, owner_id: str) -> list[dict]:
        """Актуальні позиції з посиланням, про які перевірка вже щось сказала."""
        return await self._get(
            "items",
            [
                ("select", "id,list_id,title,url,price,currency,link_status,link_price,link_currency"),
                ("owner_id", f"eq.{owner_id}"),
                ("status", "eq.active"),
                ("url", "not.is.null"),
                ("link_status", "in.(ok,out,gone)"),
            ],
        )

    async def shares(self, owner_id: str, after: datetime, until: datetime) -> list[dict]:
        return await self._get(
            "shares",
            [
                ("select", "id,title,expires_at"),
                ("owner_id", f"eq.{owner_id}"),
                ("revoked_at", "is.null"),
                ("expires_at", f"gt.{after.isoformat()}"),
                ("expires_at", f"lte.{until.isoformat()}"),
            ],
        )

    async def logged(self, owner_id: str, subject_ids: list[str]) -> set[tuple[str, str, str]]:
        """
        Що з цих предметів уже надсилали. Лише за переданими `subject_id`:
        увесь журнал власника з часом перерісши межу відповіді PostgREST
        (1000 рядків), і старі приводи почали б повторюватись.
        """
        out: set[tuple[str, str, str]] = set()
        ids = sorted(set(subject_ids))
        for start in range(0, len(ids), 100):
            chunk = ids[start : start + 100]
            rows = await self._get(
                "notification_log",
                [
                    ("select", "kind,subject_id,occurrence"),
                    ("owner_id", f"eq.{owner_id}"),
                    ("subject_id", f"in.({','.join(chunk)})"),
                ],
            )
            out |= {(r["kind"], r["subject_id"], r["occurrence"]) for r in rows}
        return out

    async def subscriptions(self, owner_id: str) -> list[Subscription]:
        rows = await self._get(
            "push_subscriptions", [("select", "id,endpoint,p256dh,auth"), ("owner_id", f"eq.{owner_id}")]
        )
        return [Subscription(r["id"], r["endpoint"], r["p256dh"], r["auth"]) for r in rows]

    async def recipient(self, owner_id: str) -> Recipient | None:
        """
        Пошта й мова — з Supabase Auth, тими самими, що й у листах Supabase
        (ADR-024). `None` — Auth зараз не відповів як слід: власника пропускаємо
        до наступного запуску, а не записуємо його події як пропущені.
        """
        res = await self._client.get(f"{self._root}/auth/v1/admin/users/{owner_id}", headers=self._headers)
        if res.status_code == 404:
            return Recipient(None, None)
        if res.status_code != 200:
            log.warning("Auth не віддав користувача: %s", res.status_code)
            return None
        user = res.json()
        confirmed = user.get("email_confirmed_at") or user.get("confirmed_at")
        meta = user.get("user_metadata") or {}
        return Recipient(user.get("email") if confirmed else None, meta.get("locale"))

    async def log(self, owner_id: str, rows: list[dict]) -> None:
        if not rows:
            return
        res = await self._client.post(
            f"{self._base}/notification_log",
            headers={**self._headers, "Prefer": "resolution=ignore-duplicates,return=minimal"},
            params={"on_conflict": "owner_id,kind,subject_id,occurrence"},
            json=[{"owner_id": owner_id, **row} for row in rows],
        )
        res.raise_for_status()

    async def mark_sent(self, owner_id: str, at: datetime) -> None:
        res = await self._client.patch(
            f"{self._base}/notification_settings",
            headers={**self._headers, "Prefer": "return=minimal"},
            params={"owner_id": f"eq.{owner_id}"},
            json={"last_sent_at": at.isoformat()},
        )
        res.raise_for_status()

    async def drop_subscription(self, sub_id: str) -> None:
        res = await self._client.delete(
            f"{self._base}/push_subscriptions", headers=self._headers, params={"id": f"eq.{sub_id}"}
        )
        res.raise_for_status()

    # ── Вхід із нового пристрою (ADR-074) ──

    async def any_known_devices(self) -> bool:
        rows = await self._get("known_devices", [("select", "owner_id"), ("limit", "1")])
        return bool(rows)

    async def recent_sign_ins(self, since: datetime, limit: int) -> list["SignIn"]:
        from .jobs_signin import SignIn

        res = await self._client.post(
            f"{self._base}/rpc/recent_sign_ins",
            headers=self._headers,
            json={"p_since": since.isoformat(), "p_limit": limit},
        )
        res.raise_for_status()
        out = []
        for r in res.json():
            at = _when(r.get("created_at"))
            if at is None or not r.get("user_id"):
                continue
            out.append(SignIn(str(r.get("session_id")), str(r["user_id"]), at, r.get("user_agent"), r.get("ip")))
        return out

    async def known_devices(self, user_ids: list[str]) -> dict[str, set[str]]:
        out: dict[str, set[str]] = {}
        for start in range(0, len(user_ids), 100):
            chunk = user_ids[start : start + 100]
            rows = await self._get(
                "known_devices", [("select", "owner_id,device"), ("owner_id", f"in.({','.join(chunk)})")]
            )
            for r in rows:
                out.setdefault(r["owner_id"], set()).add(r["device"])
        return out

    async def remember_devices(self, user_id: str, devices: list[str]) -> None:
        if not devices:
            return
        res = await self._client.post(
            f"{self._base}/known_devices",
            headers={**self._headers, "Prefer": "resolution=ignore-duplicates,return=minimal"},
            params={"on_conflict": "owner_id,device"},
            json=[{"owner_id": user_id, "device": d[:80]} for d in devices],
        )
        res.raise_for_status()

    async def signin_prefs(self, user_ids: list[str]) -> dict[str, SignInPrefs]:
        out: dict[str, SignInPrefs] = {}
        for start in range(0, len(user_ids), 100):
            chunk = user_ids[start : start + 100]
            rows = await self._get(
                "notification_settings",
                [("select", "owner_id,time_zone,signin_push,signin_email"), ("owner_id", f"in.({','.join(chunk)})")],
            )
            for r in rows:
                out[r["owner_id"]] = SignInPrefs(
                    push=bool(r.get("signin_push")),
                    email=r.get("signin_email") is not False,
                    time_zone=r.get("time_zone") or "UTC",
                )
        return out

    async def touch_subscription(self, sub_id: str, at: datetime) -> None:
        res = await self._client.patch(
            f"{self._base}/push_subscriptions",
            headers={**self._headers, "Prefer": "return=minimal"},
            params={"id": f"eq.{sub_id}"},
            json={"last_ok_at": at.isoformat()},
        )
        res.raise_for_status()

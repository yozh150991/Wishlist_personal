"""
Гостьові листи (ADR-041, п. 3–4; ADR-054): черга guest_mail → Brevo.

Сервіс wishlist-guestmail будить сигнал із бази (pg_net), а раз на 10 хвилин —
pg_cron. Сигнал не несе даних: усе, що треба для листа, береться тут із черги
secret-ключем. Тож навіть витеклий секрет сигналу дає лише зайву обробку тієї
самої черги.

Що можна й чого не можна (CLAUDE.md §3):
- адреса гостя, токен посилання й секрет відписки не йдуть у лог ніколи —
  лише лічильники;
- ключа гостя в листі немає (ADR-041, п. 3): сервер має лише його хеш;
- тема листа нейтральна — «Ваша бронь у Wishlist»: пошта не приватна, а
  сюрприз має лишитись сюрпризом. Назви позиції й списку — лише в тілі;
- до гостя — на «ви» (README пакета, «Копірайтинг»).
"""

import html
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol

import httpx

log = logging.getLogger("jobs.guestmail")

LOCALES = ("uk", "pl", "en")

TEXTS: dict[str, dict[str, str]] = {
    "uk": {
        "claim.subject": "Ваша бронь у Wishlist",
        "claim.lead": "«{item}» у списку «{list}» — за вами.",
        "claim.code": "Щоб побачити свої броні на іншому телефоні, введіть код у «Уже маю броні»: {code}",
        "code.subject": "Ваш код для Wishlist",
        "code.lead": "Код для списку «{list}»: {code}",
        "code.how": "Відкрийте список і введіть код у «Уже маю броні» — ваші броні з'являться на тому пристрої.",
        "open": "Відкрити список",
        "why.claim": "Ви вказали цю адресу, коли бронювали. Власник списку її не бачить.",
        "why.code": "Код попросили надіслати на цю адресу. Якщо це не ви — просто видаліть лист.",
        "unsubscribe": "Не надсилати листів про цей список",
    },
    "pl": {
        "claim.subject": "Twoja rezerwacja w Wishlist",
        "claim.lead": "„{item}” z listy „{list}” — jest twoje.",
        "claim.code": "Żeby zobaczyć swoje rezerwacje na innym telefonie, wpisz kod w „Mam już rezerwacje”: {code}",
        "code.subject": "Twój kod do Wishlist",
        "code.lead": "Kod do listy „{list}”: {code}",
        "code.how": "Otwórz listę i wpisz kod w „Mam już rezerwacje” — twoje rezerwacje pojawią się na tym urządzeniu.",
        "open": "Otwórz listę",
        "why.claim": "Ten adres został podany przy rezerwacji. Właściciel listy go nie widzi.",
        "why.code": "Ktoś poprosił o wysłanie kodu na ten adres. Jeśli to nie ty — po prostu usuń tę wiadomość.",
        "unsubscribe": "Nie wysyłaj wiadomości o tej liście",
    },
    "en": {
        "claim.subject": "Your pick on Wishlist",
        "claim.lead": "“{item}” on “{list}” is yours.",
        "claim.code": "To see your picks on another phone, enter this code under “I already have picks”: {code}",
        "code.subject": "Your Wishlist code",
        "code.lead": "Code for “{list}”: {code}",
        "code.how": "Open the list and enter the code under “I already have picks” — your picks will appear on that device.",
        "open": "Open the list",
        "why.claim": "You gave this address when you picked an item. The list's owner can't see it.",
        "why.code": "Someone asked for the code to be sent to this address. If it wasn't you, just delete this email.",
        "unsubscribe": "Stop emails about this list",
    },
}

#: Скільки разів пробувати Brevo, перш ніж лишити рядок у спокої.
MAX_ATTEMPTS = 5
#: Узятий рядок без відповіді довше за це — вважаємо загубленим.
STALE_AFTER = timedelta(minutes=10)
#: Надіслане й застрягле старше за це — прибираємо.
KEEP_FOR = timedelta(days=30)


def locale_of(value: object) -> str:
    return value if isinstance(value, str) and value in LOCALES else "uk"


def text(key: str, locale: str, **values: object) -> str:
    template = TEXTS[locale_of(locale)].get(key) or TEXTS["uk"][key]
    return template.format(**values)


@dataclass(frozen=True)
class Letter:
    subject: str
    html: str
    text: str


def render(kind: str, locale: str, *, item: str, list_title: str, code: str, url: str, unsubscribe: str) -> Letter:
    """Лист гостю: на бронь (`claim`) чи з кодом (`code`)."""
    locale = locale_of(locale)
    esc = html.escape
    if kind == "claim":
        subject = text("claim.subject", locale)
        lines = [text("claim.lead", locale, item=item, list=list_title), text("claim.code", locale, code=code)]
        why = text("why.claim", locale)
    else:
        subject = text("code.subject", locale)
        lines = [text("code.lead", locale, list=list_title, code=code), text("code.how", locale)]
        why = text("why.code", locale)
    open_label = text("open", locale)
    unsub_label = text("unsubscribe", locale)

    paragraphs = "".join(f"<p>{esc(line)}</p>" for line in lines)
    html_body = (
        f'<!doctype html><html lang="{locale}"><head><meta charset="utf-8"><title>{esc(subject)}</title></head>'
        f'<body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">{paragraphs}'
        f'<p><a href="{esc(url)}">{esc(open_label)}</a></p>'
        f'<hr><p><small>{esc(why)}<br><a href="{esc(unsubscribe)}">{esc(unsub_label)}</a></small></p>'
        "</body></html>"
    )
    text_body = "\n\n".join(lines) + f"\n\n{open_label}: {url}\n\n—\n{why}\n{unsub_label}: {unsubscribe}\n"
    return Letter(subject, html_body, text_body)


# ── База ─────────────────────────────────────


def _when(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@dataclass(frozen=True)
class Job:
    id: str
    kind: str
    locale: str
    attempts: int
    item: str | None
    token: str | None
    list_title: str | None
    share_live: bool
    email: str | None
    mail_off: bool
    code: str | None
    mail_token: str | None

    @staticmethod
    def from_row(row: dict, now: datetime) -> "Job":
        item = row.get("item") or {}
        share = row.get("share") or {}
        identity = row.get("identity") or {}
        expires = _when(share.get("expires_at"))
        live = bool(share) and not share.get("revoked_at") and (expires is None or expires > now)
        return Job(
            id=row["id"],
            kind=row["kind"],
            locale=locale_of(row.get("locale")),
            attempts=int(row.get("attempts") or 0),
            item=item.get("title"),
            token=share.get("token"),
            list_title=share.get("title"),
            share_live=live,
            email=identity.get("email"),
            mail_off=bool(identity.get("mail_off")),
            code=identity.get("short_code"),
            mail_token=identity.get("mail_token"),
        )


class GuestMailStore:
    """
    PostgREST із secret-ключем. Торкається лише guest_mail (читає, бере,
    позначає, прибирає); з ідентичності й посилання — лише те, що йде в лист.
    """

    SELECT = (
        "id,kind,locale,attempts,"
        "item:items(title),"
        "share:shares(token,title,revoked_at,expires_at),"
        "identity:guest_identities(email,mail_off,short_code,mail_token)"
    )

    def __init__(self, supabase_url: str, secret_key: str, client: httpx.AsyncClient):
        self._base = f"{supabase_url.rstrip('/')}/rest/v1"
        self._headers = {"apikey": secret_key}
        self._client = client

    @staticmethod
    def _free(now: datetime) -> str:
        return f"(locked_at.is.null,locked_at.lt.{(now - STALE_AFTER).isoformat()})"

    async def due(self, limit: int, now: datetime) -> list[dict]:
        res = await self._client.get(
            f"{self._base}/guest_mail",
            headers=self._headers,
            params={
                "select": self.SELECT,
                "sent_at": "is.null",
                "attempts": f"lt.{MAX_ATTEMPTS}",
                "or": self._free(now),
                "order": "created_at.asc",
                "limit": str(limit),
            },
        )
        if res.status_code in (401, 403):
            log.error("PostgREST відхилив ключ (%s): перевір SUPABASE_SECRET_KEY", res.status_code)
        res.raise_for_status()
        return res.json()

    async def take(self, job_id: str, now: datetime) -> bool:
        """Узяти рядок собі: друга копія сервісу, що прийшла слідом, його не отримає."""
        res = await self._client.patch(
            f"{self._base}/guest_mail",
            headers={**self._headers, "Prefer": "return=representation"},
            params={"id": f"eq.{job_id}", "sent_at": "is.null", "or": self._free(now), "select": "id"},
            json={"locked_at": now.isoformat()},
        )
        res.raise_for_status()
        return bool(res.json())

    async def done(self, job_id: str, now: datetime, outcome: str) -> None:
        res = await self._client.patch(
            f"{self._base}/guest_mail",
            headers=self._headers,
            params={"id": f"eq.{job_id}"},
            json={"sent_at": now.isoformat(), "outcome": outcome, "locked_at": None},
        )
        res.raise_for_status()

    async def retry(self, job_id: str, attempts: int) -> None:
        res = await self._client.patch(
            f"{self._base}/guest_mail",
            headers=self._headers,
            params={"id": f"eq.{job_id}"},
            json={"attempts": attempts, "locked_at": None},
        )
        res.raise_for_status()

    async def cleanup(self, now: datetime) -> None:
        res = await self._client.delete(
            f"{self._base}/guest_mail",
            headers=self._headers,
            params={"created_at": f"lt.{(now - KEEP_FOR).isoformat()}"},
        )
        res.raise_for_status()


# ── Обробка черги ────────────────────────────


class StoreLike(Protocol):
    async def due(self, limit: int, now: datetime) -> list[dict]: ...
    async def take(self, job_id: str, now: datetime) -> bool: ...
    async def done(self, job_id: str, now: datetime, outcome: str) -> None: ...
    async def retry(self, job_id: str, attempts: int) -> None: ...
    async def cleanup(self, now: datetime) -> None: ...


class MailerLike(Protocol):
    async def send(self, to: str, subject: str, html: str, text: str, tag: str = ...) -> bool: ...


def skip_reason(job: Job) -> str | None:
    """Чому листа не буде — або None, якщо його треба надіслати."""
    if not job.email:
        return "no_email"
    if job.kind == "claim" and job.mail_off:
        return "unsubscribed"
    if not job.share_live or not job.token:
        return "share_gone"
    if job.kind == "claim" and not job.item:
        return "item_gone"
    if not job.code or not job.mail_token:
        return "identity_gone"
    return None


async def process(store: StoreLike, mailer: MailerLike, origin: str, now: datetime, limit: int = 50) -> dict[str, int]:
    origin = origin.rstrip("/")
    counts = {"sent": 0, "skipped": 0, "failed": 0, "busy": 0}
    for row in await store.due(limit, now):
        job = Job.from_row(row, now)
        if not await store.take(job.id, now):
            counts["busy"] += 1
            continue
        if skip_reason(job):
            await store.done(job.id, now, "skipped")
            counts["skipped"] += 1
            continue
        url = f"{origin}/l/{job.token}"
        letter = render(
            job.kind,
            job.locale,
            item=job.item or "",
            list_title=job.list_title or "",
            code=job.code or "",
            url=url,
            unsubscribe=f"{url}/u/{job.mail_token}",
        )
        if await mailer.send(job.email or "", letter.subject, letter.html, letter.text, tag="wishlist-guest"):
            await store.done(job.id, now, "sent")
            counts["sent"] += 1
        else:
            await store.retry(job.id, job.attempts + 1)
            counts["failed"] += 1
    await store.cleanup(now)
    # Лише лічильники: ні адрес, ні токенів (CLAUDE.md §3.5).
    log.info("guest mail: %s", counts)
    return counts

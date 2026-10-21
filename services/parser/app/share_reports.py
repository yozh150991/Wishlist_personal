"""
Скарги гостей на посилання (потік W3, ADR-061): черга share_reports → лист
операторові застосунку через Brevo.

Будить той самий сигнал, що й гостьові листи (`/wake` у wishlist-guestmail),
і той самий добір pg_cron. Лист іде на адресу MAIL_FROM — з неї ж сервіс і
шле, тож окремої змінної немає.

Що можна й чого не можна (CLAUDE.md §3):
- у листі немає токена посилання: секрет — сама адреса. Є id посилання й
  готовий SQL, за яким оператор знайде його в базі сам;
- власник списку про скаргу не дізнається: лист — лише операторові;
- коментар гостя — як є, але в HTML екранується;
- у лог — лише лічильники.
"""

import html
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol

import httpx

log = logging.getLogger("jobs.reports")

#: Скільки разів пробувати Brevo, перш ніж лишити скаргу в спокої.
MAX_ATTEMPTS = 5
#: Узята скарга без відповіді довше за це — вважаємо загубленою.
STALE_AFTER = timedelta(minutes=10)
#: Скарги старші за це прибираємо з бази — лист давно в пошті оператора.
KEEP_FOR = timedelta(days=90)

REASONS = {
    "spam": "Спам або реклама",
    "scam": "Шахрайство",
    "offensive": "Образливий вміст",
    "illegal": "Щось незаконне",
    "other": "Інше",
}


@dataclass(frozen=True)
class Report:
    id: str
    reason: str
    comment: str | None
    locale: str
    attempts: int
    created_at: str
    owner_id: str
    share_id: str | None
    share_title: str | None
    share_live: bool

    @staticmethod
    def from_row(row: dict, now: datetime) -> "Report":
        share = row.get("share") or {}
        expires = share.get("expires_at")
        expired = False
        if isinstance(expires, str) and expires:
            expired = datetime.fromisoformat(expires.replace("Z", "+00:00")) <= now
        return Report(
            id=row["id"],
            reason=str(row.get("reason") or "other"),
            comment=row.get("comment") if isinstance(row.get("comment"), str) else None,
            locale=str(row.get("locale") or "uk"),
            attempts=int(row.get("attempts") or 0),
            created_at=str(row.get("created_at") or ""),
            owner_id=str(row.get("owner_id") or ""),
            share_id=row.get("share_id"),
            share_title=share.get("title"),
            share_live=bool(share) and not share.get("revoked_at") and not expired,
        )


@dataclass(frozen=True)
class Letter:
    subject: str
    html: str
    text: str


def render(report: Report) -> Letter:
    """Лист операторові — українською: читає його автор застосунку."""
    reason = REASONS.get(report.reason, report.reason)
    if report.share_id is None:
        state = "посилання вже видалено"
    elif report.share_live:
        state = "посилання діє"
    else:
        state = "посилання вже не діє (відкликане чи протерміноване)"
    lines = [
        f"Скарга на посилання: {reason}.",
        f"Назва посилання: «{report.share_title}»." if report.share_title else "Назва посилання невідома.",
        f"Стан: {state}.",
        f"Коментар гостя: {report.comment}" if report.comment else "Коментаря немає.",
        f"Мова гостьової: {report.locale}. Час: {report.created_at}.",
        f"Посилання: {report.share_id or '—'}. Власник: {report.owner_id}.",
    ]
    sql = (
        f"select token, title, revoked_at from shares where id = '{report.share_id}';"
        if report.share_id
        else f"select id, title from lists where owner_id = '{report.owner_id}';"
    )
    hint = "Знайти в SQL Editor Supabase:"
    esc = html.escape
    paragraphs = "".join(f"<p>{esc(line)}</p>" for line in lines)
    html_body = (
        '<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Скарга</title></head>'
        f'<body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">{paragraphs}'
        f"<p>{esc(hint)}</p><pre>{esc(sql)}</pre></body></html>"
    )
    text_body = "\n\n".join(lines) + f"\n\n{hint}\n{sql}\n"
    return Letter(f"Скарга на посилання у Wishlist: {reason}", html_body, text_body)


class ReportStore:
    """PostgREST із secret-ключем. Торкається лише share_reports; з посилання — назва й стан."""

    SELECT = "id,reason,comment,locale,attempts,created_at,owner_id,share_id,share:shares(title,revoked_at,expires_at)"

    def __init__(self, supabase_url: str, secret_key: str, client: httpx.AsyncClient):
        self._base = f"{supabase_url.rstrip('/')}/rest/v1"
        self._headers = {"apikey": secret_key}
        self._client = client

    @staticmethod
    def _free(now: datetime) -> str:
        return f"(locked_at.is.null,locked_at.lt.{(now - STALE_AFTER).isoformat()})"

    async def due(self, limit: int, now: datetime) -> list[dict]:
        res = await self._client.get(
            f"{self._base}/share_reports",
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
        res.raise_for_status()
        return res.json()

    async def take(self, report_id: str, now: datetime) -> bool:
        res = await self._client.patch(
            f"{self._base}/share_reports",
            headers={**self._headers, "Prefer": "return=representation"},
            params={"id": f"eq.{report_id}", "sent_at": "is.null", "or": self._free(now), "select": "id"},
            json={"locked_at": now.isoformat()},
        )
        res.raise_for_status()
        return bool(res.json())

    async def done(self, report_id: str, now: datetime) -> None:
        res = await self._client.patch(
            f"{self._base}/share_reports",
            headers=self._headers,
            params={"id": f"eq.{report_id}"},
            json={"sent_at": now.isoformat(), "locked_at": None},
        )
        res.raise_for_status()

    async def retry(self, report_id: str, attempts: int) -> None:
        res = await self._client.patch(
            f"{self._base}/share_reports",
            headers=self._headers,
            params={"id": f"eq.{report_id}"},
            json={"attempts": attempts, "locked_at": None},
        )
        res.raise_for_status()

    async def cleanup(self, now: datetime) -> None:
        res = await self._client.delete(
            f"{self._base}/share_reports",
            headers=self._headers,
            params={"created_at": f"lt.{(now - KEEP_FOR).isoformat()}"},
        )
        res.raise_for_status()


class StoreLike(Protocol):
    async def due(self, limit: int, now: datetime) -> list[dict]: ...
    async def take(self, report_id: str, now: datetime) -> bool: ...
    async def done(self, report_id: str, now: datetime) -> None: ...
    async def retry(self, report_id: str, attempts: int) -> None: ...
    async def cleanup(self, now: datetime) -> None: ...


class MailerLike(Protocol):
    async def send(self, to: str, subject: str, html: str, text: str, tag: str = ...) -> bool: ...


async def process(store: StoreLike, mailer: MailerLike, to: str, now: datetime, limit: int = 20) -> dict[str, int]:
    counts = {"reports": 0, "reports_failed": 0}
    for row in await store.due(limit, now):
        report = Report.from_row(row, now)
        if not await store.take(report.id, now):
            continue
        letter = render(report)
        if await mailer.send(to, letter.subject, letter.html, letter.text, tag="wishlist-report"):
            await store.done(report.id, now)
            counts["reports"] += 1
        else:
            await store.retry(report.id, report.attempts + 1)
            counts["reports_failed"] += 1
    await store.cleanup(now)
    log.info("reports: %s", counts)
    return counts

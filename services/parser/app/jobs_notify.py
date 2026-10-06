"""
Сповіщення власника (потік P, ADR-049).

Раз на годину Cloud Scheduler кличе `POST /jobs/notify`. Для кожного власника,
який щось увімкнув, сервіс дивиться на його списки, позиції й посилання і
збирає події, яких ще не надсилав:
- `after_event` — наступного дня після свята й тиждень потому: «Як минуло свято?»;
- `yearly`      — щорічне свято за місяць до річниці;
- `link`        — сторінки товару немає або його немає в наявності (ADR-048);
- `price`       — ціна в магазині відрізняється від ціни в списку на 15 % і більше;
- `share`       — посилання згасне протягом трьох днів.

Про позначки гостей подій немає й не буде (CLAUDE.md §3.2, ADR-040): сервіс
таблиць позначок не читає.

Тиша — з 22:00 до 9:00 за поясом власника: події чекають ранку. Після
надсилання наступне — не раніше ніж за три години, і все, що назбиралось,
приходить одним push і одним листом.

У лог — лише лічильники: ні назв, ні адрес, ні пошти.
"""

import hashlib
import html
import logging
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Protocol
from zoneinfo import ZoneInfo

from .jobs_push import Subscription, endpoint_allowed
from .jobs_store import Owner, Recipient
from .jobs_texts import format_date, format_money, locale_of, text

log = logging.getLogger("jobs.notify")

QUIET_FROM_HOUR = 22
QUIET_UNTIL_HOUR = 9
GROUP_HOURS = 3
AFTER_EVENT_DAYS = 7
YEARLY_REMIND_DAYS = 30
SHARE_EXPIRY_DAYS = 3
# Та сама межа, що й мітка «Ціна змінилась» на картці (itemsView.ts).
PRICE_CHANGE_PERCENT = 15
# Раз на добу — легкий виклик Brevo, щоб ключ не згас за 90 днів тиші.
KEEPALIVE_UTC_HOUR = 3
# Запуски за розкладом плавають на секунди: без запасу «рівно 3 години тому»
# через раз виходило б 2:59:5x, і все чекало б ще годину.
GROUP_SLACK = timedelta(minutes=10)
# Усі адреси з push і листів ведуть у v2: сповіщення — її функція, а вибір
# версії живе в браузері, тож без параметра пошта на телефоні відкрила б v1
# (CLAUDE.md §7: адреси з листів несуть `?design=`).
DESIGN_QUERY = "?design=v2"

_QUOTES = {"uk": ("«", "»"), "pl": ("„", "”"), "en": ("“", "”")}


@dataclass(frozen=True)
class Money:
    minor: int
    currency: str


@dataclass(frozen=True)
class Event:
    """
    Подія про предмет (`subject_id` — список, позиція чи посилання) з приводу
    (`occurrence`). Та сама трійка вдруге не надсилається (`notification_log`).
    """

    kind: str
    subject_id: str
    occurrence: str
    path: str
    text_key: str
    label: str = field(compare=False)
    values: tuple[tuple[str, object], ...] = field(default=(), compare=False)

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.kind, self.subject_id, self.occurrence)


# ── Дати ─────────────────────────────────────

def same_day_in(day: date, year: int) -> date:
    """Той самий день у вказаному році; 29 лютого в невисокосному — 28-ме."""
    for d in (day.day, 28):
        try:
            return date(year, day.month, d)
        except ValueError:
            continue
    raise ValueError(day)


def next_occurrence(event_date: date, today: date) -> date:
    """Найближча річниця, не раніше сьогодні (як `nextOccurrence` у afterEvent.ts)."""
    year = event_date.year + 1
    while True:
        candidate = same_day_in(event_date, year)
        if candidate >= today:
            return candidate
        year += 1


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ValueError, KeyError, OSError):
        return ZoneInfo("UTC")


def is_quiet(local: datetime) -> bool:
    return local.hour >= QUIET_FROM_HOUR or local.hour < QUIET_UNTIL_HOUR


def _day(value: object) -> date | None:
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _minor(value: object) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int((Decimal(str(value)) * 100).to_integral_value())
    except (InvalidOperation, ValueError):
        return None


def item_currency(item: dict, list_currency: str) -> str:
    """Валюта ціни позиції (ADR-051): своя, а NULL — валюта списку."""
    return item.get("currency") or list_currency


def price_change(item: dict, list_currency: str) -> tuple[int, int] | None:
    """
    Ціна з магазину проти ціни в списку, у мінорних одиницях — як
    `linkPriceChange` у застосунку: лише зі своєю ціною, у тій самій валюті й
    від 15 % різниці. Валюта — позиції, а якщо її немає, списку (ADR-051).
    """
    shop = _minor(item.get("link_price"))
    own = _minor(item.get("price"))
    if not shop or not own or shop == own:
        return None
    currency = item.get("link_currency")
    if currency and currency != item_currency(item, list_currency):
        return None
    if abs(shop - own) * 100 < PRICE_CHANGE_PERCENT * own:
        return None
    return shop, own


# ── Події ────────────────────────────────────

def find_events(
    owner: Owner,
    lists: list[dict],
    items: list[dict],
    shares: list[dict],
    *,
    today: date,
    logged: set[tuple[str, str, str]],
) -> list[Event]:
    tz = zone(owner.time_zone)
    out: list[Event] = []
    by_id = {row["id"]: row for row in lists}

    for row in lists:
        day = _day(row.get("event_date"))
        if day is None:
            continue
        title = row["title"]
        if owner.wants("after_event") and not row.get("is_archived") and day < today <= day + timedelta(days=AFTER_EVENT_DAYS):
            out.append(Event("after_event", row["id"], day.isoformat(), f"/lists/{row['id']}", "after_event", title, (("list", title),)))
        if owner.wants("yearly") and row.get("repeats_yearly"):
            nxt = next_occurrence(day, today)
            if (nxt - today).days <= YEARLY_REMIND_DAYS:
                out.append(
                    Event("yearly", row["id"], nxt.isoformat(), "/lists", "yearly", title, (("list", title), ("date", nxt), ("year", nxt.year)))
                )

    for item in items:
        parent = by_id.get(item.get("list_id"))
        if parent is None or parent.get("is_archived"):
            continue
        status = item.get("link_status")
        path = f"/lists/{parent['id']}"
        names = (("item", item["title"]), ("list", parent["title"]))
        if owner.wants("link") and status in ("gone", "out"):
            # Висновок належить адресі: нове посилання — новий привід.
            url_key = hashlib.sha256(str(item.get("url")).encode("utf-8")).hexdigest()[:12]
            out.append(Event("link", item["id"], f"{status}:{url_key}", path, f"link_{status}", item["title"], names))
        if owner.wants("price") and status in ("ok", "out"):
            change = price_change(item, parent.get("currency") or "")
            if change:
                shop, own = change
                currency = item_currency(item, parent.get("currency") or "")
                out.append(
                    Event(
                        "price", item["id"], f"{shop}:{currency}", path, "price", item["title"],
                        names + (("price", Money(shop, currency)), ("own", Money(own, currency))),
                    )
                )

    if owner.wants("share"):
        for row in shares:
            expires = row.get("expires_at")
            if not isinstance(expires, str):
                continue
            moment = datetime.fromisoformat(expires.replace("Z", "+00:00"))
            local_day = moment.astimezone(tz).date()
            out.append(
                Event("share", row["id"], moment.astimezone(timezone.utc).isoformat(), "/shares", "share", row["title"],
                      (("share", row["title"]), ("date", local_day)))
            )

    return [e for e in out if e.key not in logged]


# ── Тексти ───────────────────────────────────

def render(event: Event, locale: str) -> tuple[str, str]:
    values: dict[str, object] = {}
    for name, value in event.values:
        if isinstance(value, date):
            values[name] = format_date(value, locale)
        elif isinstance(value, Money):
            values[name] = format_money(value.minor, value.currency, locale)
        else:
            values[name] = value
    return text(f"{event.text_key}.title", locale, **values), text(f"{event.text_key}.body", locale, **values)


def _common_path(events: list[Event]) -> str:
    paths = {e.path for e in events}
    return paths.pop() if len(paths) == 1 else "/lists"


def app_path(path: str, fragment: str = "") -> str:
    """Адреса всередині застосунку — у v2: `/lists/…?design=v2#…`."""
    return f"{path}{DESIGN_QUERY}{('#' + fragment) if fragment else ''}"


def push_message(events: list[Event], locale: str) -> dict[str, str]:
    locale = locale_of(locale)
    if len(events) == 1:
        title, body = render(events[0], locale)
        return {"title": title, "body": body[:300], "url": app_path(events[0].path), "tag": f"wishlist-{events[0].kind}"}
    left, right = _QUOTES[locale]
    lines = [f"{render(e, locale)[0]} — {left}{e.label}{right}" for e in events[:3]]
    body = "; ".join(lines) + (" …" if len(events) > 3 else "")
    return {
        "title": text("many.title", locale, n=len(events)),
        "body": body[:300],
        "url": app_path(_common_path(events)),
        "tag": "wishlist-digest",
    }


def email_message(events: list[Event], locale: str, origin: str) -> tuple[str, str, str]:
    locale = locale_of(locale)
    origin = origin.rstrip("/")
    rendered = [(e, *render(e, locale)) for e in events]
    subject = rendered[0][1] if len(events) == 1 else text("many.title", locale, n=len(events))
    open_label = text("email.open", locale)
    settings_url = f"{origin}{app_path('/settings', 'notifications')}"
    esc = html.escape

    blocks = "".join(
        f'<p><strong>{esc(title)}</strong><br>{esc(body)}<br><a href="{esc(origin + app_path(e.path))}">{esc(open_label)}</a></p>'
        for e, title, body in rendered
    )
    html_body = (
        f'<!doctype html><html lang="{locale}"><head><meta charset="utf-8"><title>{esc(subject)}</title></head>'
        f'<body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">{blocks}'
        f'<hr><p><small>{esc(text("email.why", locale))} '
        f'<a href="{esc(settings_url)}">{esc(text("email.settings", locale))}</a></small></p></body></html>'
    )
    text_body = "\n\n".join(f"{title}\n{body}\n{origin}{app_path(e.path)}" for e, title, body in rendered)
    text_body += f"\n\n—\n{text('email.why', locale)}\n{text('email.settings', locale)}: {settings_url}\n"
    return subject, html_body, text_body


# ── Запуск ───────────────────────────────────

class StoreLike(Protocol):
    async def owners(self) -> list[Owner]: ...
    async def lists(self, owner_id: str) -> list[dict]: ...
    async def items(self, owner_id: str) -> list[dict]: ...
    async def shares(self, owner_id: str, after: datetime, until: datetime) -> list[dict]: ...
    async def logged(self, owner_id: str, subject_ids: list[str]) -> set[tuple[str, str, str]]: ...
    async def subscriptions(self, owner_id: str) -> list[Subscription]: ...
    async def recipient(self, owner_id: str) -> Recipient | None: ...
    async def log(self, owner_id: str, rows: list[dict]) -> None: ...
    async def mark_sent(self, owner_id: str, at: datetime) -> None: ...
    async def drop_subscription(self, sub_id: str) -> None: ...
    async def touch_subscription(self, sub_id: str, at: datetime) -> None: ...


class PusherLike(Protocol):
    async def send(self, sub: Subscription, message: dict[str, str]) -> str: ...


class MailerLike(Protocol):
    async def send(self, to: str, subject: str, html: str, text: str) -> bool: ...
    async def ping(self) -> str: ...


def _in(event: Event, events: Iterable[Event]) -> bool:
    return any(event.key == e.key for e in events)


async def run(
    store: StoreLike,
    pusher: PusherLike,
    mailer: MailerLike,
    *,
    origin: str,
    now: datetime | None = None,
) -> dict[str, int]:
    now = now or datetime.now(timezone.utc)
    summary: Counter[str] = Counter()

    if now.hour == KEEPALIVE_UTC_HOUR:
        summary[f"brevo_{await mailer.ping()}"] += 1

    for owner in await store.owners():
        # Один власник зі зламаними даними чи збій бази на ньому не зупиняє
        # решту: його черга просто чекає наступної години.
        try:
            await _notify_owner(store, pusher, mailer, owner, now=now, origin=origin, summary=summary)
        except Exception as exc:  # noqa: BLE001
            log.warning("сповіщення власника не вдалися: %s", type(exc).__name__)
            summary["errors"] += 1

    result = dict(summary)
    # Лише лічильники: хто, що й куди — приватна річ.
    log.info("notify %s", result)
    return result


async def _notify_owner(
    store: StoreLike,
    pusher: PusherLike,
    mailer: MailerLike,
    owner: Owner,
    *,
    now: datetime,
    origin: str,
    summary: Counter[str],
) -> None:
    local = now.astimezone(zone(owner.time_zone))
    if is_quiet(local):
        summary["quiet"] += 1
        return
    if owner.last_sent_at and now - owner.last_sent_at < timedelta(hours=GROUP_HOURS) - GROUP_SLACK:
        summary["waiting"] += 1
        return

    lists = await store.lists(owner.id)
    items = await store.items(owner.id) if owner.wants("link") or owner.wants("price") else []
    shares = await store.shares(owner.id, now, now + timedelta(days=SHARE_EXPIRY_DAYS)) if owner.wants("share") else []
    candidates = find_events(owner, lists, items, shares, today=local.date(), logged=set())
    if not candidates:
        return
    logged = await store.logged(owner.id, [e.subject_id for e in candidates])
    found = [e for e in candidates if e.key not in logged]
    if not found:
        return

    wants_push = [e for e in found if owner.prefs[e.kind][0]]
    wants_mail = [e for e in found if owner.prefs[e.kind][1]]
    subs: list[Subscription] = []
    if wants_push:
        for sub in await store.subscriptions(owner.id):
            if endpoint_allowed(sub.endpoint):
                subs.append(sub)
            else:
                # Не служба push — працювати не буде ніколи: прибираємо.
                await store.drop_subscription(sub.id)
                summary["push_blocked"] += 1
    who = await store.recipient(owner.id)
    if who is None:
        summary["auth_unavailable"] += 1
        return
    locale = locale_of(who.locale)
    push_events = wants_push if subs else []
    mail_events = wants_mail if who.email else []

    pushed = False
    if push_events:
        message = push_message(push_events, locale)
        for sub in subs:
            result = await pusher.send(sub, message)
            if result == "ok":
                pushed = True
                await store.touch_subscription(sub.id, now)
            elif result in ("gone", "blocked"):
                # Підписки більше немає (404/410) або вона зіпсована — прибираємо.
                await store.drop_subscription(sub.id)
                summary[f"push_{result}"] += 1

    mailed = False
    if mail_events and who.email:
        mailed = await mailer.send(who.email, *email_message(mail_events, locale, origin))

    rows: list[dict] = []
    for event in found:
        channels = []
        if pushed and _in(event, push_events):
            channels.append("push")
        if mailed and _in(event, mail_events):
            channels.append("email")
        attempted = _in(event, push_events) or _in(event, mail_events)
        # Не вийшло жодним каналом — спробуємо за годину. Не було куди
        # (push без пристроїв, пошта не підтверджена) — записуємо як
        # пропущене, щоб не перебирати ту саму подію щогодини.
        if channels or not attempted:
            rows.append({"kind": event.kind, "subject_id": event.subject_id, "occurrence": event.occurrence, "channels": channels})
            if not channels:
                summary["dropped"] += 1
    await store.log(owner.id, rows)
    if pushed or mailed:
        await store.mark_sent(owner.id, now)
    summary["events"] += len(found)
    summary["push"] += int(pushed)
    summary["email"] += int(mailed)

"""
Вхід із нового пристрою (ADR-074).

Щогодини, тим самим викликом `POST /jobs/notify`, сервіс бере сесії Supabase
Auth, створені за останні `WINDOW` (`recent_sign_ins`), і зводить User-Agent
кожної до «браузер · система» — Chrome · Android, Safari · iOS. Пристрій,
якого в акаунта ще не було (`known_devices`), у акаунта, що вже мав інші, —
привід для листа (і push, якщо ввімкнено):
- одразу, без тиші 22:00–9:00 і без «не частіше ніж раз на 3 години»
  (ADR-049): це безпека, а не новини;
- окремим листом, не разом з іншими сповіщеннями;
- типово листом для всіх, навіть без рядка налаштувань.

Перший пристрій акаунта (реєстрація, перший вхід після появи функції) лише
запам'ятовується. Найперший запуск сервісу запам'ятовує пристрої всіх живих
сесій мовчки: інакше кожен, хто вже має два пристрої, отримав би лист у день
запуску.

Пристрій стає «відомим» лише після того, як лист чи push пішли (або слати
було нікуди). Не вийшло — наступного запуску спроба повториться, поки сесія в
межах вікна.

У журнал — лише лічильники: ні пошти, ні пристроїв, ні IP.
"""

import html
import logging
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol

from .jobs_notify import zone
from .jobs_push import Subscription, endpoint_allowed
from .jobs_store import Recipient, SignInPrefs
from .jobs_texts import format_date, locale_of, text

log = logging.getLogger("jobs.signin")

#: Запуск щогодини; вікно з запасом, щоб збій одного запуску не губив вхід.
WINDOW = timedelta(hours=3)
#: Найперший запуск: усі живі сесії — від початку часів.
EPOCH = datetime(2000, 1, 1, tzinfo=timezone.utc)
#: Скільки сесій за запуск. Для особистого вішліста — з величезним запасом.
LIMIT = 1000
UNKNOWN = "?"


@dataclass(frozen=True)
class SignIn:
    session_id: str
    user_id: str
    created_at: datetime
    user_agent: str | None
    ip: str | None


# ── Пристрій із User-Agent ───────────────────

# Порядок важливий: Edge і Opera пишуть «Chrome», Chrome пише «Safari».
_BROWSERS: tuple[tuple[str, str], ...] = (
    (r"\bEdg(?:e|A|iOS)?/", "Edge"),
    (r"\b(?:OPR|Opera)/", "Opera"),
    (r"\bSamsungBrowser/", "Samsung Internet"),
    (r"\bYaBrowser/", "Yandex Browser"),
    (r"\b(?:Firefox|FxiOS)/", "Firefox"),
    (r"\b(?:CriOS|Chrome|Chromium)/", "Chrome"),
    (r"\bVersion/[\d.]+.*\bSafari/", "Safari"),
)

_SYSTEMS: tuple[tuple[str, str], ...] = (
    (r"\biPad\b", "iPadOS"),
    (r"\b(?:iPhone|iPod)\b", "iOS"),
    (r"\bAndroid\b", "Android"),
    (r"\bCrOS\b", "ChromeOS"),
    (r"\bWindows\b", "Windows"),
    (r"\bMac OS X\b|\bMacintosh\b", "macOS"),
    (r"\bLinux\b", "Linux"),
)

# Програма замість браузера: «curl/8.4», «python-httpx/0.27», «Go-http-client/2.0».
_PROGRAM = re.compile(r"^([A-Za-z][A-Za-z0-9._-]{0,39})/")


def device_of(user_agent: str | None) -> str:
    """
    «Браузер · система» без версій — оновлення браузера не робить пристрій
    новим. Програма без браузера — її назва (вхід через API напряму теж
    помітний). Порожньо — `?`: такий «пристрій» теж запам'ятовується.
    """
    ua = (user_agent or "").strip()[:512]
    if not ua:
        return UNKNOWN
    browser = next((name for pattern, name in _BROWSERS if re.search(pattern, ua)), None)
    system = next((name for pattern, name in _SYSTEMS if re.search(pattern, ua)), None)
    if browser and system:
        return f"{browser} · {system}"
    if browser or system:
        return browser or system  # type: ignore[return-value]
    program = _PROGRAM.match(ua)
    return program.group(1).lower() if program else UNKNOWN


# ── Тексти ───────────────────────────────────

@dataclass(frozen=True)
class NewDevice:
    device: str
    at: datetime
    ip: str | None


def _when(at: datetime, tz: str, locale: str) -> str:
    local = at.astimezone(zone(tz))
    return f"{format_date(local.date(), locale)}, {local:%H:%M}"


def _device_label(device: str, locale: str) -> str:
    return text("signin.unknown_device", locale) if device == UNKNOWN else device


def push_message(devices: list[NewDevice], locale: str) -> dict[str, str]:
    first = devices[0]
    return {
        "title": text("signin.title", locale),
        "body": _device_label(first.device, locale),
        "url": "/settings#security",
        "tag": "wishlist-signin",
    }


def email_message(devices: list[NewDevice], locale: str, tz: str, origin: str) -> tuple[str, str, str]:
    esc = html.escape
    security_url = f"{origin}/settings#security"
    reset_url = f"{origin}/reset"
    lines = []
    for d in devices:
        where = _device_label(d.device, locale)
        when = _when(d.at, tz, locale)
        ip = text("signin.ip", locale, ip=d.ip) if d.ip else ""
        lines.append(" · ".join(part for part in (where, when, ip) if part))
    subject = text("signin.title", locale)
    lead = text("signin.lead", locale)
    zone_note = text("signin.zone", locale, zone=tz)
    ok = text("signin.ok", locale)
    not_you = text("signin.not_you", locale)
    html_body = (
        f'<!doctype html><html lang="{locale}"><head><meta charset="utf-8"><title>{esc(subject)}</title></head>'
        f'<body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">'
        f"<p>{esc(lead)}</p><ul>{''.join(f'<li>{esc(line)}</li>' for line in lines)}</ul>"
        f"<p><small>{esc(zone_note)}</small></p>"
        f"<p>{esc(ok)}</p>"
        f"<p><strong>{esc(not_you)}</strong></p>"
        f'<p><a href="{esc(reset_url)}">{esc(text("signin.reset", locale))}</a> · '
        f'<a href="{esc(security_url)}">{esc(text("signin.everywhere", locale))}</a></p>'
        f'<hr><p><small>{esc(text("signin.why", locale))} '
        f'<a href="{esc(security_url)}">{esc(text("signin.settings", locale))}</a></small></p></body></html>'
    )
    text_body = (
        f"{lead}\n\n" + "\n".join(f"- {line}" for line in lines) + f"\n\n{zone_note}\n\n{ok}\n\n{not_you}\n"
        f"{text('signin.reset', locale)}: {reset_url}\n{text('signin.everywhere', locale)}: {security_url}\n\n"
        f"—\n{text('signin.why', locale)}\n{text('signin.settings', locale)}: {security_url}\n"
    )
    return subject, html_body, text_body


# ── Запуск ───────────────────────────────────

class StoreLike(Protocol):
    async def any_known_devices(self) -> bool: ...
    async def recent_sign_ins(self, since: datetime, limit: int) -> list[SignIn]: ...
    async def known_devices(self, user_ids: list[str]) -> dict[str, set[str]]: ...
    async def remember_devices(self, user_id: str, devices: list[str]) -> None: ...
    async def signin_prefs(self, user_ids: list[str]) -> dict[str, SignInPrefs]: ...
    async def subscriptions(self, owner_id: str) -> list[Subscription]: ...
    async def recipient(self, owner_id: str) -> Recipient | None: ...
    async def drop_subscription(self, sub_id: str) -> None: ...
    async def touch_subscription(self, sub_id: str, at: datetime) -> None: ...


class PusherLike(Protocol):
    async def send(self, sub: Subscription, message: dict[str, str]) -> str: ...


class MailerLike(Protocol):
    async def send(self, to: str, subject: str, html: str, text: str) -> bool: ...


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

    bootstrap = not await store.any_known_devices()
    sign_ins = await store.recent_sign_ins(EPOCH if bootstrap else now - WINDOW, LIMIT)
    if not sign_ins:
        return {}

    # Користувач → пристрій → найпізніший вхід із нього.
    latest: dict[str, dict[str, SignIn]] = {}
    for s in sign_ins:
        per_user = latest.setdefault(s.user_id, {})
        device = device_of(s.user_agent)
        if device not in per_user or per_user[device].created_at < s.created_at:
            per_user[device] = s

    user_ids = sorted(latest)
    known = await store.known_devices(user_ids)
    prefs = await store.signin_prefs(user_ids) if not bootstrap else {}

    for user_id in user_ids:
        try:
            await _one(
                store, pusher, mailer, user_id, latest[user_id], known.get(user_id, set()),
                prefs.get(user_id, SignInPrefs()), bootstrap=bootstrap, now=now, origin=origin, summary=summary,
            )
        except Exception as exc:  # noqa: BLE001 — один користувач не зупиняє решту
            log.warning("вхід не оброблено: %s", type(exc).__name__)
            summary["signin_errors"] += 1

    result = dict(summary)
    log.info("signin %s", result)
    return result


async def _one(
    store: StoreLike,
    pusher: PusherLike,
    mailer: MailerLike,
    user_id: str,
    devices: dict[str, SignIn],
    known: set[str],
    prefs: SignInPrefs,
    *,
    bootstrap: bool,
    now: datetime,
    origin: str,
    summary: Counter[str],
) -> None:
    new = [d for d in devices if d not in known]
    if not new:
        return
    # Найперший запуск і перший пристрій акаунта — лише запам'ятати.
    if bootstrap or not known:
        await store.remember_devices(user_id, new)
        summary["signin_first"] += len(new)
        return

    found = sorted((NewDevice(d, devices[d].created_at, devices[d].ip) for d in new), key=lambda x: x.at)
    if not prefs.push and not prefs.email:
        await store.remember_devices(user_id, new)
        summary["signin_off"] += 1
        return

    who = await store.recipient(user_id)
    if who is None:
        # Auth не відповів — пристрої лишаються новими, спробуємо за годину.
        summary["signin_auth_unavailable"] += 1
        return
    locale = locale_of(who.locale)

    subs: list[Subscription] = []
    if prefs.push:
        for sub in await store.subscriptions(user_id):
            if endpoint_allowed(sub.endpoint):
                subs.append(sub)
            else:
                await store.drop_subscription(sub.id)

    pushed = False
    if subs:
        message = push_message(found, locale)
        for sub in subs:
            result = await pusher.send(sub, message)
            if result == "ok":
                pushed = True
                await store.touch_subscription(sub.id, now)
            elif result in ("gone", "blocked"):
                await store.drop_subscription(sub.id)

    mailed = False
    mail_wanted = prefs.email and bool(who.email)
    if mail_wanted:
        mailed = await mailer.send(who.email, *email_message(found, locale, prefs.time_zone, origin))  # type: ignore[arg-type]

    attempted = bool(subs) or mail_wanted
    if pushed or mailed or not attempted:
        await store.remember_devices(user_id, new)
        summary["signin_alerts"] += int(pushed or mailed)
        summary["signin_nowhere"] += int(not attempted)
    else:
        summary["signin_retry"] += 1

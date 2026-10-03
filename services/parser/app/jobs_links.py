"""
Щоденна перевірка посилань на товар (потік R, ADR-048).

Сторінку відкриває той самий `fetch_html`, що й парсер: перевірка схеми,
жодної приватної адреси, IP-пін проти DNS rebinding, ліміт розміру (ADR-012).
Висновок — лише про сторінку: є, немає в наявності, немає самої сторінки.
Ціну з магазину запам'ятовуємо, але в списку не міняємо.

Сайти не бомбардуємо: одночасно кілька різних хостів, а в межах одного —
по черзі з паузою. Час роботи обмежений: що не встигли — завтра.
"""

import asyncio
import logging
import time
from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from typing import Protocol
from urllib.parse import urlsplit

from fastapi import HTTPException

from .extract import availability, extract
from .fetcher import UpstreamError, fetch_html
from .jobs_store import Target, Verdict

log = logging.getLogger("jobs.links")

Fetch = Callable[[str], Awaitable[str]]


class StoreLike(Protocol):
    async def due(self, limit: int, checked_before: datetime) -> list[Target]: ...
    async def save(self, target: Target, verdict: Verdict, checked_at: datetime) -> None: ...


# «Сторінки немає» кажуть лише ці коди. 403, 429, 5xx — нічого певного.
_GONE_STATUSES = (404, 410)


async def check_one(url: str, fetch: Fetch = fetch_html) -> Verdict:
    try:
        html = await fetch(url)
    except UpstreamError as exc:
        return Verdict("gone") if exc.upstream_status in _GONE_STATUSES else Verdict(None)
    except HTTPException:
        # Тайм-аут, заблокований хост, не HTML — про товар це нічого не каже.
        return Verdict(None)

    parsed = extract(html, url)
    status = "out" if availability(html) is False else "ok"
    return Verdict(status, parsed.price, parsed.currency)


async def run(
    store: StoreLike,
    *,
    batch: int,
    budget_seconds: float,
    recheck_hours: float,
    host_delay: float,
    concurrency: int,
    fetch: Fetch = fetch_html,
    check: Callable[[str, Fetch], Awaitable[Verdict]] = check_one,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> dict[str, int]:
    deadline = clock() + budget_seconds
    summary: Counter[str] = Counter()
    gate = asyncio.Semaphore(concurrency)

    async def host_worker(targets: list[Target]) -> None:
        async with gate:
            for i, target in enumerate(targets):
                if clock() >= deadline:
                    summary["deferred"] += len(targets) - i
                    return
                if i:
                    await sleep(host_delay)
                verdict = await check(target.url, fetch)
                await store.save(target, verdict, datetime.now(timezone.utc))
                summary[verdict.status or "kept"] += 1

    while clock() < deadline:
        checked_before = datetime.now(timezone.utc) - timedelta(hours=recheck_hours)
        targets = await store.due(batch, checked_before)
        if not targets:
            break
        by_host: dict[str, list[Target]] = defaultdict(list)
        for target in targets:
            by_host[(urlsplit(target.url).hostname or "").lower()].append(target)
        await asyncio.gather(*(host_worker(group) for group in by_host.values()))
        if summary["deferred"]:
            break

    result = dict(summary)
    result["checked"] = sum(v for k, v in summary.items() if k != "deferred")
    # Лише лічильники: адреси товарів — приватна річ, у лог не йдуть.
    log.info("check-links %s", result)
    return result

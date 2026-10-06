"""
Курс НБП для підказки «≈ … за курсом НБП від …» (ADR-051).

Раз на добу — на початку перевірки посилань, тим самим викликом Cloud
Scheduler, щоб не заводити третю задачу розкладу, — беремо таблицю A
Національного банку Польщі: середній курс до злотого для EUR, USD і UAH.
Відкритий API без ключа, лише фіксована адреса НБП — жодних адрес від людей,
тож безпечний завантажувач парсера тут не потрібен.

Курс — лише підказка власнику. Ні ціни, ні суми ним не перераховуються, а
збій НБП не зупиняє перевірку посилань: у застосунку лишається вчорашній
курс із датою, або підказки немає зовсім.
"""

import logging
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Protocol

import httpx

log = logging.getLogger("jobs.rates")

NBP_TABLE_A = "https://api.nbp.pl/api/exchangerates/tables/A/?format=json"

#: Валюти застосунку, крім злотого: для нього курс завжди 1, у таблиці його немає.
CODES = ("EUR", "USD", "UAH")


@dataclass(frozen=True)
class Rate:
    currency: str
    pln_per_unit: Decimal
    rate_date: date


class RatesStoreLike(Protocol):
    async def save_rates(self, rates: list[Rate]) -> None: ...


def parse_table(payload: object) -> list[Rate]:
    """
    Відповідь НБП — масив з однією таблицею: `effectiveDate` і `rates` з
    `code` та `mid`. Беремо лише наші валюти й лише додатний курс; решту
    мовчки пропускаємо, щоб зіпсований рядок не зірвав інші.
    """
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], dict):
        raise ValueError("unexpected_nbp_payload")
    table = payload[0]
    try:
        day = date.fromisoformat(str(table.get("effectiveDate")))
    except ValueError as e:
        raise ValueError("unexpected_nbp_date") from e
    out: list[Rate] = []
    for row in table.get("rates") or []:
        if not isinstance(row, dict) or row.get("code") not in CODES:
            continue
        try:
            mid = Decimal(str(row.get("mid")))
        except (InvalidOperation, ValueError):
            continue
        if mid > 0:
            out.append(Rate(row["code"], mid, day))
    return out


async def fetch_table(client: httpx.AsyncClient) -> list[Rate]:
    res = await client.get(NBP_TABLE_A, headers={"accept": "application/json"}, timeout=10.0)
    res.raise_for_status()
    return parse_table(res.json())


async def refresh(store: RatesStoreLike, client: httpx.AsyncClient) -> int:
    """Скільки курсів записано; 0 — НБП не відповів або відповів не тим (не помилка задачі)."""
    try:
        rates = await fetch_table(client)
    except (httpx.HTTPError, ValueError) as e:
        log.warning("курс НБП не оновлено: %s", type(e).__name__)
        return 0
    if not rates:
        log.warning("курс НБП не оновлено: у таблиці немає потрібних валют")
        return 0
    await store.save_rates(rates)
    return len(rates)

"""
Web Push для сповіщень власника (ADR-049): VAPID (RFC 8292) і шифрування
aes128gcm (RFC 8291).

Адресу підписки дає браузер власника, тобто її може підставити будь-хто з
акаунтом. Сервіс із ключем бази не має ходити куди завгодно (ADR-012,
CLAUDE.md §3.6), тож push іде лише на хости відомих служб push — Google,
Mozilla, Apple, Microsoft — і лише https на стандартному порту. Решта адрес
відкидається без запиту.

Адреса підписки — секрет рівня токена: у лог вона не йде ніколи.
"""

import base64
import json
import logging
import os
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import http_ece
import httpx
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid02

log = logging.getLogger("jobs.push")

# Служби push браузерів. Піддомени — так, будь-що інше — ні.
PUSH_HOSTS = ("fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com")

# Скільки служба push тримає сповіщення для вимкненого пристрою.
TTL_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class Subscription:
    id: str
    endpoint: str
    p256dh: str
    auth: str


def endpoint_allowed(endpoint: str) -> bool:
    try:
        parts = urlsplit(endpoint)
        port = parts.port
    except ValueError:
        return False
    if parts.scheme != "https" or port not in (None, 443) or parts.username or parts.password:
        return False
    host = (parts.hostname or "").lower().rstrip(".")
    return any(host == h or host.endswith("." + h) for h in PUSH_HOSTS)


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def encrypt(payload: bytes, sub: Subscription) -> bytes:
    """Тіло push, яке прочитає лише цей браузер (RFC 8291, aes128gcm)."""
    return http_ece.encrypt(
        payload,
        salt=os.urandom(16),
        private_key=ec.generate_private_key(ec.SECP256R1()),
        dh=_b64url_decode(sub.p256dh),
        auth_secret=_b64url_decode(sub.auth),
        version="aes128gcm",
    )


class Pusher:
    def __init__(self, vapid_private_key: str, contact_email: str, client: httpx.AsyncClient):
        self._vapid = Vapid02.from_string(vapid_private_key)
        self._subject = f"mailto:{contact_email}"
        self._client = client

    def _headers(self, endpoint: str) -> dict[str, str]:
        parts = urlsplit(endpoint)
        claims = {"aud": f"{parts.scheme}://{parts.hostname}", "sub": self._subject, "exp": int(time.time()) + 12 * 3600}
        return {
            **self._vapid.sign(claims),
            "TTL": str(TTL_SECONDS),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "Urgency": "normal",
        }

    async def send(self, sub: Subscription, message: dict[str, str]) -> str:
        """
        `ok` — служба прийняла; `gone` — підписки більше немає (404/410), рядок
        треба прибрати; `failed` — спробуємо наступного разу; `blocked` — адреса
        не схожа на службу push, запиту не було.
        """
        if not endpoint_allowed(sub.endpoint):
            return "blocked"
        try:
            body = encrypt(json.dumps(message, ensure_ascii=False).encode("utf-8"), sub)
            headers = self._headers(sub.endpoint)
        except Exception:  # noqa: BLE001 — зіпсовані ключі браузера: ця підписка не працюватиме ніколи
            return "blocked"
        try:
            res = await self._client.post(sub.endpoint, content=body, headers=headers)
        except httpx.InvalidURL:
            return "blocked"
        except Exception as exc:  # noqa: BLE001 — мережа, тайм-аут: спробуємо наступного разу
            log.warning("push не дійшов до служби: %s", type(exc).__name__)
            return "failed"
        if res.status_code in (200, 201, 202):
            return "ok"
        if res.status_code in (404, 410):
            return "gone"
        log.warning("служба push відповіла %s", res.status_code)
        return "failed"

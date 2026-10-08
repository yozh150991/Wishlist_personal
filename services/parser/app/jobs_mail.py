"""
Листи через Brevo API: власникові (ADR-049) і гостям (ADR-054).

Ключ Brevo — із Secret Manager, у заголовку `api-key`. Адреса отримувача в
лог не йде ніколи. Brevo вимикає ключ, яким 90 днів не зроблено жодного
успішного виклику, а тихі місяці без листів — звична річ; тому сервіс раз на
добу питає `GET /account` (`ping`), і ключ лишається живим.
"""

import logging

import httpx

log = logging.getLogger("jobs.mail")

BREVO_API = "https://api.brevo.com/v3"


class Mailer:
    def __init__(self, api_key: str, sender: str, client: httpx.AsyncClient):
        self._headers = {"api-key": api_key, "accept": "application/json"}
        self._sender = sender
        self._client = client

    async def send(self, to: str, subject: str, html: str, text: str, tag: str = "wishlist-notify") -> bool:
        body = {
            "sender": {"email": self._sender, "name": "Wishlist"},
            "to": [{"email": to}],
            "subject": subject,
            "htmlContent": html,
            "textContent": text,
            "tags": [tag],
        }
        try:
            res = await self._client.post(f"{BREVO_API}/smtp/email", headers=self._headers, json=body)
        except httpx.HTTPError as exc:
            log.warning("Brevo недоступний: %s", type(exc).__name__)
            return False
        if res.status_code in (200, 201, 202):
            return True
        if res.status_code in (401, 403):
            log.error("Brevo відхилив ключ (%s): перевір BREVO_API_KEY і Authorized IPs", res.status_code)
        else:
            log.warning("Brevo не прийняв лист: %s", res.status_code)
        return False

    async def ping(self) -> str:
        """`ok` — ключ живий; `refused` — Brevo його не приймає; `unreachable` — Brevo мовчить."""
        try:
            res = await self._client.get(f"{BREVO_API}/account", headers=self._headers)
        except httpx.HTTPError:
            return "unreachable"
        if res.status_code == 200:
            return "ok"
        if res.status_code in (401, 403):
            log.error("Brevo відхилив ключ (%s): перевір BREVO_API_KEY і Authorized IPs", res.status_code)
            return "refused"
        return "unreachable"

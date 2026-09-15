import ipaddress
import logging
import socket
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, status

from .config import settings

log = logging.getLogger("parser.fetcher")


class BlockedHost(Exception):
    pass


def _is_public(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    # link_local покриває 169.254.0.0/16 — саме там метадані GCP.
    # Без цієї перевірки сервіс на VM віддав би токени сервісного акаунта.
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def assert_public_url(url: str) -> None:
    """Перевіряє схему і те, що ВСІ адреси хоста — публічні."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise BlockedHost("scheme")
    if not parsed.hostname:
        raise BlockedHost("host")

    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror as exc:
        raise BlockedHost("dns") from exc

    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise BlockedHost("dns")
    # Достатньо однієї приватної адреси, щоб відмовити: домен може
    # резолвитись одночасно в публічну і внутрішню (DNS rebinding).
    for ip in addresses:
        if not _is_public(ip):
            raise BlockedHost("private")


async def fetch_html(url: str) -> str:
    """
    Тягне HTML із зовнішнього сайту з обмеженнями.

    Редиректи обробляються вручну: кожен новий URL проходить ту саму
    перевірку, інакше публічний домен міг би перекинути на 127.0.0.1.
    """
    cfg = settings()
    current = url

    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=cfg.parser_timeout_seconds,
        headers={
            "User-Agent": "WishlistPersonalBot/0.1 (+personal wishlist link preview)",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "uk,pl;q=0.9,en;q=0.8",
        },
    ) as client:
        for _ in range(cfg.parser_max_redirects + 1):
            try:
                assert_public_url(current)
            except BlockedHost as exc:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "blocked_host") from exc

            try:
                async with client.stream("GET", current) as res:
                    if res.is_redirect:
                        location = res.headers.get("location")
                        if not location:
                            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "bad_redirect")
                        current = str(httpx.URL(current).join(location))
                        continue

                    if res.status_code >= 400:
                        log.info(
                            "магазин відмовив: host=%s status=%s",
                            httpx.URL(current).host,
                            res.status_code,
                        )
                        # 401/403/429 від магазину — це антибот-захист, а не
                        # поломка. Великі маркетплейси перевіряють JS і cookies,
                        # і відрізняти це від реальної помилки корисно.
                        if res.status_code in (401, 403, 405, 429):
                            raise HTTPException(
                                status.HTTP_502_BAD_GATEWAY, "upstream_forbidden"
                            )
                        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "upstream_error")

                    ctype = res.headers.get("content-type", "")
                    if "html" not in ctype.lower():
                        raise HTTPException(
                            status.HTTP_422_UNPROCESSABLE_ENTITY, "unsupported_content"
                        )

                    # Читаємо потоком і обриваємо на ліміті, але не відмовляємо:
                    # мета-теги лежать у <head>, тобто в перших кілобайтах.
                    # Сторінки на Shopify з вбудованим JSON часто важать
                    # більше за ліміт, і відмова означала б втрату даних,
                    # які вже прочитані.
                    chunks: list[bytes] = []
                    size = 0
                    truncated = False
                    async for chunk in res.aiter_bytes():
                        chunks.append(chunk)
                        size += len(chunk)
                        if size >= cfg.parser_max_bytes:
                            truncated = True
                            break

                    if truncated:
                        log.info(
                            "сторінку обрізано на ліміті: host=%s bytes=%s",
                            httpx.URL(current).host,
                            size,
                        )

                    raw = b"".join(chunks)
                    encoding = res.charset_encoding or "utf-8"
                    return raw.decode(encoding, errors="replace")

            except httpx.TimeoutException as exc:
                raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "upstream_timeout") from exc
            except httpx.HTTPError as exc:
                raise HTTPException(status.HTTP_502_BAD_GATEWAY, "upstream_error") from exc

    raise HTTPException(status.HTTP_502_BAD_GATEWAY, "too_many_redirects")

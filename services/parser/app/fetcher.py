import ipaddress
import logging
import socket
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import HTTPException, status

from .config import settings

log = logging.getLogger("parser.fetcher")


class BlockedHost(Exception):
    pass


def _is_public(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    # is_global — білий список за реєстром спеціальних адрес IANA, а не набір
    # окремих is_* прапорів, який легко забути доповнити новим діапазоном.
    # Зокрема покриває 169.254.0.0/16 (метадані хмари) і 100.64.0.0/10 (CGNAT,
    # куди потрапляють VPC-конектори), який жоден is_private не відсікає.
    #
    # Multicast доводиться відсікати окремо: для 224.0.0.0/4 і ff00::/8
    # is_global повертає True, хоча раніше ці адреси блокувались.
    return addr.is_global and not addr.is_multicast and not addr.is_unspecified


def _resolve_public_addresses(hostname: str) -> list[str]:
    """
    Резолвить хост і повертає адреси, якщо ВСІ вони публічні.

    Порядок: спершу IPv4, потім IPv6. Cloud Run (як і більшість середовищ
    без окремо ввімкненого IPv6) вихідних IPv6-зʼєднань не має, тож дуально
    стековий магазин при зворотному порядку був би недоступний.
    """
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        raise BlockedHost("dns") from exc

    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise BlockedHost("dns")
    # Достатньо однієї приватної адреси, щоб відмовити: домен може
    # резолвитись одночасно в публічну і внутрішню в ОДНІЙ DNS-відповіді.
    for ip in addresses:
        if not _is_public(ip):
            raise BlockedHost("private")

    return sorted(addresses, key=lambda ip: (ipaddress.ip_address(ip).version, ip))


def assert_public_url(url: str) -> None:
    """Перевіряє схему і те, що ВСІ адреси хоста — публічні."""
    _pinned_targets(url)


def _pinned_targets(url: str) -> tuple[list[str], str, str]:
    """
    Резолвить хост, перевіряє адреси й повертає (адреси для зʼєднання,
    hostname, значення заголовка Host).

    Зʼєднання йде на перевірену IP, а не на hostname. Це закриває DNS
    rebinding МІЖ резолвами: раніше перевірка резолвила хост один раз, а httpx
    робив власний резолв під час зʼєднання — DNS атакуючого міг віддати
    публічну адресу на першу відповідь і 127.0.0.1 чи 169.254.169.254 на
    другу. Host і SNI лишаються справжнім hostname, тож сервер віддає той
    самий вміст, а сертифікат перевіряється коректно.
    """
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https"):
        raise BlockedHost("scheme")
    hostname = parsed.hostname
    if not hostname:
        raise BlockedHost("host")

    addresses = _resolve_public_addresses(hostname)

    targets: list[str] = []
    for ip in addresses:
        netloc = f"[{ip}]" if ":" in ip else ip
        if parsed.port:
            netloc += f":{parsed.port}"
        targets.append(
            urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))
        )

    host_header = f"{hostname}:{parsed.port}" if parsed.port else hostname
    return targets, hostname, host_header


async def _read_page(res: httpx.Response, cfg, host: str | None) -> str:
    if res.status_code >= 400:
        log.info("магазин відмовив: host=%s status=%s", host, res.status_code)
        # 401/403/429 від магазину — це антибот-захист, а не поломка. Великі
        # маркетплейси перевіряють JS і cookies, і відрізняти це корисно.
        if res.status_code in (401, 403, 405, 429):
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "upstream_forbidden")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "upstream_error")

    ctype = res.headers.get("content-type", "")
    if "html" not in ctype.lower():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "unsupported_content")

    # Читаємо потоком і обриваємо на ліміті, але не відмовляємо: мета-теги
    # лежать у <head>, тобто в перших кілобайтах. Сторінки на Shopify з
    # вбудованим JSON часто важать більше за ліміт, і відмова означала б
    # втрату даних, які вже прочитані.
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
        log.info("сторінку обрізано на ліміті: host=%s bytes=%s", host, size)

    raw = b"".join(chunks)
    return raw.decode(res.charset_encoding or "utf-8", errors="replace")


async def _fetch_hop(
    client: httpx.AsyncClient,
    targets: list[str],
    hostname: str,
    host_header: str,
    current: str,
    cfg,
) -> tuple[str, str]:
    """
    Один перехід: пробує перевірені адреси хоста по черзі.

    Повертає ("html", вміст) або ("redirect", наступний URL).
    Перебір потрібен, бо зʼєднання пінується на конкретну IP: без нього
    хост із кількома адресами, де перша не відповідає, став би недоступним,
    хоча httpx сам пробує всі адреси.
    """
    connect_error: Exception | None = None

    for pinned in targets:
        try:
            async with client.stream(
                "GET",
                pinned,
                headers={"Host": host_header},
                extensions={"sni_hostname": hostname},
            ) as res:
                if res.is_redirect:
                    location = res.headers.get("location")
                    if not location:
                        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "bad_redirect")
                    # Відносний шлях розгортається від справжнього URL, не від IP.
                    return "redirect", str(httpx.URL(current).join(location))

                return "html", await _read_page(res, cfg, httpx.URL(current).host)

        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            # Саме ця адреса недоступна — пробуємо наступну.
            connect_error = exc
            continue
        except httpx.TimeoutException as exc:
            raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "upstream_timeout") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "upstream_error") from exc

    log.info("жодна адреса хоста не відповіла: host=%s", hostname)
    raise HTTPException(status.HTTP_502_BAD_GATEWAY, "upstream_error") from connect_error


async def fetch_html(url: str, transport: httpx.AsyncBaseTransport | None = None) -> str:
    """
    Тягне HTML із зовнішнього сайту з обмеженнями.

    Редиректи обробляються вручну: кожен новий URL проходить ту саму перевірку,
    інакше публічний домен міг би перекинути на 127.0.0.1. Зʼєднання завжди йде
    на вже перевірену IP (`_pinned_targets`).

    `transport` призначений лише для тестів (підміна мережі); у проді завжди
    None, і httpx використовує звичайний TCP/TLS-транспорт.
    """
    cfg = settings()
    current = url

    async with httpx.AsyncClient(
        transport=transport,
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
                targets, hostname, host_header = _pinned_targets(current)
            except BlockedHost as exc:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "blocked_host") from exc

            kind, value = await _fetch_hop(client, targets, hostname, host_header, current, cfg)
            if kind == "html":
                return value
            current = value

    raise HTTPException(status.HTTP_502_BAD_GATEWAY, "too_many_redirects")

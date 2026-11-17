import codecs
import ipaddress
import logging
import re
import socket
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import HTTPException, status

from .config import settings

log = logging.getLogger("parser.fetcher")


class BlockedHost(Exception):
    pass


class UpstreamError(HTTPException):
    """
    Магазин відповів помилкою. Для /parse це той самий 502 з тим самим
    `detail`, а перевірці посилань (wishlist-jobs, ADR-048) потрібен ще й
    справжній код: 404 і 410 кажуть «сторінки немає», а 403 чи 503 — нічого.
    """

    def __init__(self, detail: str, upstream_status: int | None = None):
        super().__init__(status.HTTP_502_BAD_GATEWAY, detail)
        self.upstream_status = upstream_status


# IPv6, що несуть усередині IPv4: зʼєднання з ними може дійти до вбудованої
# адреси (NAT64-шлюз, 6to4, застарілі IPv4-сумісні). Тож вбудована IPv4 теж
# мусить бути публічною (BUG-QA-20).
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_IPV4_COMPAT = ipaddress.ip_network("::/96")


def _embedded_ipv4(addr: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    if addr.ipv4_mapped is not None:
        return addr.ipv4_mapped
    if addr.sixtofour is not None:
        return addr.sixtofour
    if addr in _NAT64 or addr in _IPV4_COMPAT:
        return ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF)
    return None


def _is_public(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address):
        inner = _embedded_ipv4(addr)
        if inner is not None and not _is_public(str(inner)):
            return False
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


# --- Кодування сторінки -----------------------------------------------------
#
# Порядок — як у браузера (HTML, «визначення кодування»): BOM → charset із
# Content-Type → <meta> на початку сторінки → UTF-8. Раніше було лише друге й
# четверте: сторінка у windows-1251 чи iso-8859-2, що називає кодування тільки
# в <meta>, читалась як UTF-8, і назва приходила з «�» (аудит 15 листопада, A-3).

_BOMS = (
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)

#: Скільки байтів з початку сторінки переглядаємо в пошуку <meta>. Стандарт
#: вимагає оголошення в перших 1024; беремо із запасом — частина магазинів
#: ставить перед ним довгі коментарі й скрипти.
_META_SCAN_BYTES = 4096

_PROBE = b'<meta charset="a-1">'
_COMMENT = re.compile(rb"<!--.*?(?:-->|\Z)", re.DOTALL)
_META_TAG = re.compile(rb"""<meta(?=[\s/])((?:[^>"']|"[^"]*"|'[^']*')*)>""", re.IGNORECASE)
_ATTR = re.compile(rb"""([^\s=/"'>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""")
_CONTENT_CHARSET = re.compile(rb"""charset\s*=\s*["']?\s*([^\s"';]+)""", re.IGNORECASE)


def _text_codec(label: str | None, *, from_meta: bool = False) -> str | None:
    """
    Назва кодування для `bytes.decode` або None, якщо такою сторінку не
    прочитати. Невідома назва (`charset=foo-bar`) раніше давала LookupError і
    500 на /parse (A-2); тепер вона — те саме, що відсутня.

    `codecs.lookup` знає не лише кодування тексту: `hex` і `base64` — байти в
    байти, `undefined` та `idna` кидають помилку на будь-якому вході, а
    `punycode` на великій сторінці рахується хвилинами. Тому назву пробуємо на
    шматку ASCII: веб-кодування, крім UTF-16/32, його не змінюють.

    З <meta> UTF-16/32 не приймаємо: якби сторінка справді була такою, <meta>
    не прочитався б побайтно (стандарт у цьому разі каже читати як UTF-8).
    """
    if not label or len(label) > 64:
        return None
    try:
        name = codecs.lookup(label.strip()).name
        ascii_compatible = _PROBE.decode(name, "replace") == _PROBE.decode("ascii")
    except (LookupError, ValueError):  # UnicodeError — підклас ValueError
        return None
    if ascii_compatible:
        return name
    if not from_meta and name.startswith(("utf-16", "utf-32")):
        return name
    return None


def _meta_charset(head: bytes) -> str | None:
    """
    Кодування з `<meta charset="…">` або
    `<meta http-equiv="Content-Type" content="…; charset=…">` на початку
    сторінки. Закоментований тег не рахується; `content` без
    `http-equiv="Content-Type"` — теж (це може бути опис сторінки зі словом
    «charset»). Невідома назва — шукаємо далі.
    """
    head = _COMMENT.sub(b"", head[:_META_SCAN_BYTES])
    for tag in _META_TAG.finditer(head):
        attrs: dict[bytes, bytes] = {}
        for found in _ATTR.finditer(tag.group(1)):
            name = found.group(1).lower()
            # Перший атрибут із такою назвою виграє, як у браузері.
            attrs.setdefault(name, found.group(2) or found.group(3) or found.group(4) or b"")

        label = attrs.get(b"charset")
        if label is None and attrs.get(b"http-equiv", b"").strip().lower() == b"content-type":
            in_content = _CONTENT_CHARSET.search(attrs.get(b"content", b""))
            label = in_content.group(1) if in_content else None
        if label:
            codec = _text_codec(label.decode("ascii", "ignore"), from_meta=True)
            if codec:
                return codec
    return None


def page_encoding(raw: bytes, header_charset: str | None) -> str:
    """
    Чим читати сторінку: BOM → charset із заголовка → <meta> → UTF-8.

    Заголовок сильніший за <meta>, коли вони кажуть різне: так читає сторінку
    й браузер, тож магазин бачить на ній те саме, що й ми.
    """
    for bom, codec in _BOMS:
        if raw.startswith(bom):
            return codec
    return _text_codec(header_charset) or _meta_charset(raw) or "utf-8"


def decode_page(raw: bytes, header_charset: str | None, truncated: bool = False) -> str:
    """
    Байти сторінки → текст. Ніколи не кидає: зіпсовані байти стають «�».

    Сторінку, обрізану на ліміті розміру, могло розрізати посеред
    багатобайтового символу — такий неповний хвіст просто відкидаємо.
    """
    codec = page_encoding(raw, header_charset)
    try:
        return codecs.getincrementaldecoder(codec)("replace").decode(raw, final=not truncated)
    except (LookupError, ValueError):
        # Запасний шлях: кодек пройшов пробу, але впав на справжніх байтах.
        return raw.decode("utf-8", errors="replace")


async def _read_page(res: httpx.Response, cfg, host: str | None) -> str:
    if res.status_code >= 400:
        log.info("магазин відмовив: host=%s status=%s", host, res.status_code)
        # 401/403/429 від магазину — це антибот-захист, а не поломка. Великі
        # маркетплейси перевіряють JS і cookies, і відрізняти це корисно.
        if res.status_code in (401, 403, 405, 429):
            raise UpstreamError("upstream_forbidden", res.status_code)
        raise UpstreamError("upstream_error", res.status_code)

    ctype = res.headers.get("content-type", "")
    # Amazon та інші відповідають ботам «успіхом» без сторінки: 202 Accepted
    # або відповідь без Content-Type (живий прогін, 27 жовтня: з Cloud Run
    # Amazon давав 422 unsupported_content, з домашньої IP — сторінку). Це
    # той самий захист від ботів, що й 403: людині кажемо чесно.
    if res.status_code == 202 or not ctype.strip():
        log.info("магазин не віддав сторінку: host=%s status=%s ctype=%r", host, res.status_code, ctype)
        raise UpstreamError("upstream_forbidden", res.status_code)
    if "html" not in ctype.lower():
        # Порожня відповідь «text/plain» — теж відмова, а не інший формат.
        empty = True
        stream = res.aiter_bytes()
        try:
            async for chunk in stream:
                if chunk.strip():
                    empty = False
                    break
        finally:
            await stream.aclose()
        log.info("не HTML: host=%s status=%s ctype=%r empty=%s", host, res.status_code, ctype, empty)
        if empty:
            raise UpstreamError("upstream_forbidden", res.status_code)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "unsupported_content")

    # Читаємо потоком і обриваємо на ліміті, але не відмовляємо: мета-теги
    # лежать у <head>, тобто в перших кілобайтах. Сторінки на Shopify з
    # вбудованим JSON часто важать більше за ліміт, і відмова означала б
    # втрату даних, які вже прочитані.
    chunks: list[bytes] = []
    size = 0
    truncated = False
    stream = res.aiter_bytes()
    try:
        async for chunk in stream:
            chunks.append(chunk)
            size += len(chunk)
            if size >= cfg.parser_max_bytes:
                truncated = True
                break
    finally:
        # Обірваний на ліміті потік закриваємо самі, як і в гілці «не HTML».
        await stream.aclose()

    if truncated:
        log.info("сторінку обрізано на ліміті: host=%s bytes=%s", host, size)

    return decode_page(b"".join(chunks), res.charset_encoding, truncated)


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

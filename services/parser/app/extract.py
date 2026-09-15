import json
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .models import ParseResponse

CURRENCY_SIGNS = {
    "zł": "PLN", "pln": "PLN",
    "₴": "UAH", "грн": "UAH", "uah": "UAH",
    "€": "EUR", "eur": "EUR",
    "$": "USD", "usd": "USD",
}


def parse_price(raw: object) -> float | None:
    """
    Витягує число з рядків на кшталт '1 299,00 zł', '1,299.00', '399'.

    Роздільник визначаємо за останнім розділовим знаком: якщо після нього
    рівно дві цифри — це десяткова кома, усе решта відкидаємо як розряди.
    """
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if raw >= 0 else None

    text = str(raw).strip()
    if not text:
        return None

    # Спершу вирізаємо саме число, а не просто викидаємо все зайве:
    # інакше крапка з "9,99/szt." прилипала до числа й читалась як
    # десятковий роздільник без цифр після себе.
    match = re.search(r"\d[\d\s\u00a0.,]*", text)
    if not match:
        return None
    text = match.group(0).replace("\u00a0", "").replace(" ", "").strip(".,")
    if not text:
        return None

    last_sep = max(text.rfind(","), text.rfind("."))
    if last_sep != -1 and len(text) - last_sep - 1 == 2:
        integer = re.sub(r"[.,]", "", text[:last_sep])
        value = f"{integer}.{text[last_sep + 1:]}"
    else:
        value = re.sub(r"[.,]", "", text)

    try:
        number = float(value)
    except ValueError:
        return None
    return number if number >= 0 else None


def normalise_currency(raw: object) -> str | None:
    if not raw:
        return None
    text = str(raw).strip().lower()
    if len(text) == 3 and text.isalpha():
        return text.upper()
    for sign, code in CURRENCY_SIGNS.items():
        if sign in text:
            return code
    return None


def _iter_jsonld(soup: BeautifulSoup):
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(tag.string or "")
        except (json.JSONDecodeError, TypeError):
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, dict):
                yield node
                stack.extend(v for v in node.values() if isinstance(v, (dict, list)))


def _first_image(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, list) and value:
        return _first_image(value[0])
    if isinstance(value, dict):
        return _first_image(value.get("url"))
    return None


# Селектори останньої надії. Порядок від точнішого до ширшого.
_PRICE_SELECTORS = (
    "[data-price]",
    '[class*="price" i]',
    '[id*="price" i]',
)


# Ціна має або десяткову частину з двох цифр, або знак валюти поруч.
# Без цієї вимоги евристика хапала "365" з назви "IKEA 365+", бо назва
# лежить у блоці, де в класі є "price".
_DECIMAL_TAIL = re.compile(r"\d[.,]\d{2}(?!\d)")
_CURRENCY_NEAR = re.compile(
    r"(zł|pln|грн|₴|uah|€|eur|\$|usd)", re.IGNORECASE
)


def _looks_like_price(text: str) -> bool:
    return bool(_DECIMAL_TAIL.search(text) or _CURRENCY_NEAR.search(text))


def _heuristic_price(soup: BeautifulSoup) -> float | None:
    """
    Шукає ціну в тексті елементів, у чиїх класах чи атрибутах є 'price'.

    Потрібно для магазинів без розмітки — IKEA, наприклад, віддає
    OpenGraph без ціни, а саму ціну малює в тексті. Джерело ненадійне,
    тому в confidence воно позначається окремо: користувач бачить
    значення у формі й може виправити.
    """
    for selector in _PRICE_SELECTORS:
        for tag in soup.select(selector)[:40]:
            # data-price ставлять навмисно — йому віримо без додаткових умов.
            explicit = tag.get("data-price")
            if explicit:
                value = parse_price(explicit)
                if value:
                    return value
                continue

            text = tag.get_text(" ", strip=True)
            if not text or len(text) > 40 or not _looks_like_price(text):
                continue
            value = parse_price(text)
            if value:
                return value
    return None


def extract(html: str, url: str) -> ParseResponse:
    """
    Порядок джерел: JSON-LD → microdata → OpenGraph → Twitter → <title>.
    Перше знайдене значення виграє, джерело записується в confidence.
    """
    soup = BeautifulSoup(html, "html.parser")
    out = ParseResponse(url=url)
    src: dict[str, str] = {}

    def put(field: str, value: object, source: str) -> None:
        if field in src or value in (None, ""):
            return
        setattr(out, field, value)
        src[field] = source

    # 1. JSON-LD schema.org/Product
    for node in _iter_jsonld(soup):
        types = node.get("@type")
        types = [types] if isinstance(types, str) else (types or [])
        if "Product" not in types:
            continue
        put("title", node.get("name"), "jsonld")
        put("image_url", _first_image(node.get("image")), "jsonld")

        offers = node.get("offers")
        offers = offers[0] if isinstance(offers, list) and offers else offers
        if isinstance(offers, dict):
            put("price", parse_price(offers.get("price")), "jsonld")
            put("currency", normalise_currency(offers.get("priceCurrency")), "jsonld")

    # 2. Microdata
    for tag in soup.select("[itemprop]"):
        prop = tag.get("itemprop")
        value = tag.get("content") or tag.get("href") or tag.get("src") or tag.get_text(" ", strip=True)
        if prop == "name":
            put("title", value, "microdata")
        elif prop == "price":
            put("price", parse_price(value), "microdata")
        elif prop == "priceCurrency":
            put("currency", normalise_currency(value), "microdata")
        elif prop == "image":
            put("image_url", value, "microdata")

    # 3. OpenGraph
    meta = {
        tag.get("property") or tag.get("name"): tag.get("content")
        for tag in soup.find_all("meta")
        if (tag.get("property") or tag.get("name")) and tag.get("content")
    }
    put("title", meta.get("og:title"), "og")
    put("image_url", meta.get("og:image"), "og")
    put("site_name", meta.get("og:site_name"), "og")
    put("price", parse_price(meta.get("product:price:amount") or meta.get("og:price:amount")), "og")
    put("currency", normalise_currency(
        meta.get("product:price:currency") or meta.get("og:price:currency")), "og")

    # 4. Twitter Card
    put("title", meta.get("twitter:title"), "twitter")
    put("image_url", meta.get("twitter:image"), "twitter")

    # 5. Остання надія для назви
    if soup.title and soup.title.string:
        put("title", soup.title.string.strip(), "title")

    # 6. Ціни в розмітці не знайшлось — пробуємо текст сторінки
    if out.price is None:
        put("price", _heuristic_price(soup), "heuristic")

    if out.image_url:
        out.image_url = urljoin(url, out.image_url)
    if not out.site_name:
        out.site_name = urlparse(url).hostname
    if out.title:
        out.title = re.sub(r"\s+", " ", out.title).strip()[:200]

    out.confidence = src
    out.partial = not (out.title and out.price is not None)
    return out

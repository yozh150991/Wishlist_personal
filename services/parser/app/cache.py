import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .models import ParseResponse

# Рекламні мітки не впливають на вміст сторінки, але роздувають кеш
# і роблять посилання довжелезними.
_TRACKING_PREFIXES = ("utm_", "tw_", "gad_", "pk_", "mc_", "ref_")
_TRACKING_EXACT = {
    "gclid", "gbraid", "wbraid", "fbclid", "msclkid", "dclid",
    "yclid", "igshid", "mkt_tok", "ref", "referrer",
}


def strip_tracking(url: str) -> str:
    parts = urlsplit(url)
    kept = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k.lower() not in _TRACKING_EXACT
        and not any(k.lower().startswith(p) for p in _TRACKING_PREFIXES)
    ]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(kept), parts.fragment))

_cache: dict[str, tuple[ParseResponse, float]] = {}
_MAX_ENTRIES = 500


def normalise(url: str) -> str:
    """Відкидає фрагмент і кінцевий слеш, щоб кеш не дублювався дарма."""
    parts = urlsplit(url)
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def get(url: str) -> ParseResponse | None:
    entry = _cache.get(normalise(url))
    if not entry:
        return None
    value, expires = entry
    if expires <= time.monotonic():
        _cache.pop(normalise(url), None)
        return None
    return value


def put(url: str, value: ParseResponse, ttl: int) -> None:
    now = time.monotonic()
    for key in [k for k, (_, exp) in _cache.items() if exp <= now]:
        _cache.pop(key, None)
    if len(_cache) >= _MAX_ENTRIES:
        # Найстаріший за часом закінчення — найближчий до витіснення.
        oldest = min(_cache.items(), key=lambda kv: kv[1][1])[0]
        _cache.pop(oldest, None)
    _cache[normalise(url)] = (value, now + ttl)

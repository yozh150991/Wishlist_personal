import logging
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from . import cache, ratelimit
from .auth import require_user
from .config import settings
from .extract import extract
from .fetcher import fetch_html
from .models import ParseRequest, ParseResponse

log = logging.getLogger("parser")

app = FastAPI(title="Wishlist parser", version="0.1.0", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings().origins,
    allow_methods=["POST", "GET"],
    allow_headers=["authorization", "content-type"],
)


@app.get("/health")
async def health() -> dict[str, object]:
    cfg = settings()
    # supabase_configured дає змогу перевірити налаштування без токена:
    # false тут одразу пояснює 503 на /parse.
    return {
        "status": "ok",
        "version": "0.1.0",
        "supabase_configured": cfg.supabase_ready,
        "allowed_origins": cfg.origins,
    }


@app.post("/parse", response_model=ParseResponse)
async def parse(body: ParseRequest, user_id: str = Depends(require_user)) -> ParseResponse:
    cfg = settings()

    parsed = urlparse(body.url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_url")

    ratelimit.check(user_id, cfg.parser_rate_limit_per_min)

    # Рекламний хвіст відкидаємо до запиту: він не змінює сторінку,
    # але ламає кеш і тягнеться в збережене посилання.
    target = cache.strip_tracking(body.url)

    hit = cache.get(target)
    if hit:
        return hit

    html = await fetch_html(target)
    result = extract(html, target)
    cache.put(target, result, cfg.parser_cache_ttl_seconds)

    # Логуємо хост, не повний URL: посилання на подарунок — приватна річ.
    log.info("parsed host=%s partial=%s", parsed.hostname, result.partial)
    return result

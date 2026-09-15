import logging
import time

import httpx
from fastapi import HTTPException, Request, status

from .config import settings

log = logging.getLogger("parser.auth")

# token -> (user_id, коли протухне в кеші)
_cache: dict[str, tuple[str, float]] = {}


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing_token")
    return token


async def require_user(request: Request) -> str:
    """
    Перевіряє токен у самого Supabase (ADR-018).

    Не розбираємо і не звіряємо підпис самі: проєкт може підписувати
    токени як асиметрично, так і спільним секретом HS256, і сервіс не
    повинен про це знати. Відповіді кешуються на кілька хвилин, щоб не
    ходити в Supabase на кожен запит.
    """
    cfg = settings()
    token = _bearer(request)

    now = time.monotonic()
    hit = _cache.get(token)
    if hit and hit[1] > now:
        return hit[0]

    # Прибираємо протухлі записи, щоб кеш не ріс без меж.
    for key in [k for k, (_, exp) in _cache.items() if exp <= now]:
        _cache.pop(key, None)

    if not cfg.supabase_ready:
        log.error(
            "SUPABASE_URL не заповнено або лишився шаблон з .env.example: %r",
            cfg.supabase_url,
        )
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "supabase_not_configured")

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.get(
                f"{cfg.supabase_url}/auth/v1/user",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": cfg.supabase_publishable_key,
                },
            )
    except httpx.HTTPError as exc:
        # Без цього рядка 503 неможливо відрізнити від мережевої проблеми.
        log.error("не вдалося звернутись до Supabase (%s): %s", cfg.supabase_url, exc)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "auth_unavailable") from exc

    if res.status_code != 200:
        log.warning("Supabase відхилив токен: %s", res.status_code)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_token")

    user_id = res.json().get("id")
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_token")

    _cache[token] = (user_id, now + cfg.parser_token_cache_seconds)
    return user_id

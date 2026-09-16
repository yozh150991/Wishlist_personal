import logging
import re
import time

import httpx
from fastapi import HTTPException, Request, status

from .config import settings

log = logging.getLogger("parser.auth")

# token -> (user_id, коли протухне в кеші)
_cache: dict[str, tuple[str, float]] = {}

# Токен доступу Supabase — це JWT: три частини base64url через крапку.
# Перевіряємо лише форму, не вміст і не підпис (це робить Supabase, ADR-018).
# Форма потрібна з двох причин:
#   1. HTTP-заголовки мають бути ASCII. Кирилиця чи інше сміття в токені
#      валило httpx з UnicodeEncodeError ще до запиту, і клієнт отримував
#      голий 500 замість 401.
#   2. Явно фальшивий токен не варто везти в Supabase: це зайвий мережевий
#      запит на кожну спробу.
_JWT_RE = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")

# Звичайний токен Supabase — близько 1 КБ. Запас на великі app_metadata.
_MAX_TOKEN_LEN = 8192


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "").strip()
    scheme, _, token = header.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing_token")
    if len(token) > _MAX_TOKEN_LEN or not _JWT_RE.fullmatch(token):
        # Сам токен у лог не пишемо ніколи — лише факт і довжину.
        log.warning("токен неправильної форми відхилено без запиту до Supabase (довжина %d)", len(token))
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_token")
    return token


async def require_user(request: Request) -> str:
    """
    Перевіряє токен у самого Supabase (ADR-018).

    Не розбираємо і не звіряємо підпис самі: проєкт може підписувати
    токени як асиметрично, так і спільним секретом HS256, і сервіс не
    повинен про це знати. Локально перевіряється лише форма токена —
    див. коментар до _JWT_RE. Відповіді кешуються на кілька хвилин,
    щоб не ходити в Supabase на кожен запит.
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

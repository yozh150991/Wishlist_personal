"""
Перевірка форми токена до звернення в Supabase.

Жоден тест тут не ходить у мережу: httpx.AsyncClient підмінено на заглушку,
яка валить тест, якщо до неї дійшло. Так перевіряється не лише код відповіді,
а й те, що сміттєвий токен справді не поїхав у Supabase.
"""

import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app import auth
from app.config import Settings

# Схожий на справжній за формою, але вигаданий.
VALID_SHAPE = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ"


def make_request(authorization: bytes | None) -> Request:
    headers = [] if authorization is None else [(b"authorization", authorization)]
    return Request({"type": "http", "method": "POST", "path": "/parse", "headers": headers})


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    class Forbidden:
        def __init__(self, *args, **kwargs):
            raise AssertionError("звернення до Supabase не мало відбутися")

    monkeypatch.setattr(auth.httpx, "AsyncClient", Forbidden)
    # Налаштування не з .env: локально там справжня адреса Supabase, а в CI файлу
    # немає, і без підміни токен правильної форми впирався б у supabase_not_configured
    # замість того, щоб дійти до заглушки. Тест не має залежати від машини.
    monkeypatch.setattr(
        auth,
        "settings",
        lambda: Settings(supabase_url="https://example.supabase.co", _env_file=None),
    )
    auth._cache.clear()


def status_and_detail(authorization: bytes | None) -> tuple[int, str]:
    with pytest.raises(HTTPException) as exc:
        asyncio.run(auth.require_user(make_request(authorization)))
    return exc.value.status_code, exc.value.detail


@pytest.mark.parametrize(
    "header",
    [
        None,
        b"",
        b"Bearer",
        b"Bearer ",
        b"Basic dXNlcjpwYXNz",
        VALID_SHAPE.encode(),  # без схеми
    ],
)
def test_missing_token(header):
    assert status_and_detail(header) == (401, "missing_token")


@pytest.mark.parametrize(
    "header",
    [
        # Саме цей випадок давав 500 на бойовому сервісі: шаблон із DEPLOY.md.
        "Bearer <токен>".encode("utf-8"),
        "Bearer токен.токен.токен".encode("utf-8"),
        b"Bearer \xff\xfe\xfd",
        b"Bearer not-a-jwt",
        b"Bearer a.b",
        b"Bearer a.b.",
        b"Bearer a..c",
        b"Bearer a.b.c.d",
        b"Bearer a.b.c d",
        b"Bearer a.b.c+/=",
        b"Bearer " + b"a" * 5000 + b"." + b"b" * 5000 + b".c",
    ],
)
def test_malformed_token_is_401_without_calling_supabase(header):
    assert status_and_detail(header) == (401, "invalid_token")


def test_valid_shape_passes_local_check():
    assert auth._bearer(make_request(b"Bearer " + VALID_SHAPE.encode())) == VALID_SHAPE


def test_scheme_is_case_insensitive_and_whitespace_tolerated():
    assert auth._bearer(make_request(b"bearer   " + VALID_SHAPE.encode() + b"  ")) == VALID_SHAPE


def test_valid_shape_reaches_supabase():
    # Заглушка кидає AssertionError саме в момент звернення — отже перевірка форми пройдена.
    with pytest.raises(AssertionError, match="Supabase"):
        asyncio.run(auth.require_user(make_request(b"Bearer " + VALID_SHAPE.encode())))

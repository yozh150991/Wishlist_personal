"""
Гостьові листи (ADR-054): тексти, правила пропуску, обробка черги, сховище
й відкритий сервіс /wake.

Мережі немає: Brevo й PostgREST заступає respx або підмінні класи. Окремо
стережемо те, що робить відкритий сервіс безпечним: без правильного секрету
нічого не відбувається, запит не несе даних, а в лог не йдуть ні адреси, ні
токени посилань, ні секрети відписки.
"""

import logging
import string
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app import guest_mail
from app import mail_main
from app.guest_mail import GuestMailStore, Job, render, skip_reason
from app.jobs_config import JobSettings, job_settings
from app.jobs_mail import Mailer

NOW = datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)
ORIGIN = "https://wishlist.example"
SECRET = "wake-secret-0123456789abcdef-0123456789"


def row(**over) -> dict:
    base = {
        "id": "m1",
        "kind": "claim",
        "locale": "uk",
        "attempts": 0,
        "item": {"title": "Кавоварка"},
        "share": {"token": "shareTokenAAAAAAAAAAAAA", "title": "Весілля Олега", "revoked_at": None, "expires_at": None},
        "identity": {"email": "ira@pochta.ua", "mail_off": False, "short_code": "K7M2Q", "mail_token": "mailTokenBBBBBBBBBBBBBB"},
    }
    base.update(over)
    return base


# ── Тексти ───────────────────────────────────


def test_texts_have_the_same_keys_in_every_locale():
    keys = set(guest_mail.TEXTS["uk"])
    for loc in guest_mail.LOCALES:
        assert set(guest_mail.TEXTS[loc]) == keys


def test_placeholders_match_across_locales():
    def fields(s: str) -> set[str]:
        return {f for _, f, _, _ in string.Formatter().parse(s) if f}

    for key, uk in guest_mail.TEXTS["uk"].items():
        for loc in ("pl", "en"):
            assert fields(guest_mail.TEXTS[loc][key]) == fields(uk), (loc, key)


@pytest.mark.parametrize("locale", guest_mail.LOCALES)
@pytest.mark.parametrize("kind", ["claim", "code"])
def test_subject_says_nothing_about_list_or_item(locale, kind):
    letter = render(kind, locale, item="Кавоварка", list_title="Весілля Олега", code="K7M2Q",
                    url=f"{ORIGIN}/l/t", unsubscribe=f"{ORIGIN}/l/t/u/m")
    assert "Кавоварка" not in letter.subject
    assert "Весілля" not in letter.subject
    assert "K7M2Q" not in letter.subject


def test_claim_letter_has_item_list_code_link_and_unsubscribe():
    letter = render("claim", "uk", item="Кавоварка", list_title="Весілля Олега", code="K7M2Q",
                    url=f"{ORIGIN}/l/tok", unsubscribe=f"{ORIGIN}/l/tok/u/mt")
    for part in ("Кавоварка", "Весілля Олега", "K7M2Q", f"{ORIGIN}/l/tok", f"{ORIGIN}/l/tok/u/mt"):
        assert part in letter.text
        assert part in letter.html
    assert "Власник списку її не бачить" in letter.text


def test_html_is_escaped():
    letter = render("claim", "en", item='<script>"x"</script>', list_title="A & B", code="K7M2Q",
                    url=f"{ORIGIN}/l/t", unsubscribe=f"{ORIGIN}/l/t/u/m")
    assert "<script>" not in letter.html
    assert "&lt;script&gt;" in letter.html
    assert "A &amp; B" in letter.html


def test_unknown_locale_falls_back_to_ukrainian():
    assert render("code", "de", item="", list_title="L", code="K7M2Q", url="u", unsubscribe="x").subject == (
        guest_mail.TEXTS["uk"]["code.subject"]
    )


# ── Коли листа не буде ───────────────────────


def test_skip_rules():
    assert skip_reason(Job.from_row(row(), NOW)) is None
    assert skip_reason(Job.from_row(row(identity={**row()["identity"], "email": None}), NOW)) == "no_email"
    assert skip_reason(Job.from_row(row(identity={**row()["identity"], "mail_off": True}), NOW)) == "unsubscribed"
    revoked = row(share={**row()["share"], "revoked_at": "2026-10-19T10:00:00+00:00"})
    assert skip_reason(Job.from_row(revoked, NOW)) == "share_gone"
    expired = row(share={**row()["share"], "expires_at": (NOW - timedelta(minutes=1)).isoformat()})
    assert skip_reason(Job.from_row(expired, NOW)) == "share_gone"
    assert skip_reason(Job.from_row(row(item=None), NOW)) == "item_gone"


def test_code_letter_ignores_unsubscribe():
    """Код людина просить сама — відписка від листів списку на нього не діє."""
    job = Job.from_row(row(kind="code", item=None, identity={**row()["identity"], "mail_off": True}), NOW)
    assert skip_reason(job) is None


# ── Обробка черги ────────────────────────────


class FakeStore:
    def __init__(self, rows: list[dict], taken: bool = True):
        self.rows = rows
        self.taken = taken
        self.done_calls: list[tuple[str, str]] = []
        self.retries: list[tuple[str, int]] = []
        self.cleaned = False

    async def due(self, limit, now):
        return self.rows[:limit]

    async def take(self, job_id, now):
        return self.taken

    async def done(self, job_id, now, outcome):
        self.done_calls.append((job_id, outcome))

    async def retry(self, job_id, attempts):
        self.retries.append((job_id, attempts))

    async def cleanup(self, now):
        self.cleaned = True


class FakeMailer:
    def __init__(self, ok: bool = True):
        self.ok = ok
        self.sent: list[dict] = []

    async def send(self, to, subject, html, text, tag="wishlist-notify"):
        self.sent.append({"to": to, "subject": subject, "text": text, "tag": tag})
        return self.ok


@pytest.mark.asyncio
async def test_process_sends_and_marks_done():
    store, mailer = FakeStore([row()]), FakeMailer()
    counts = await guest_mail.process(store, mailer, ORIGIN + "/", NOW)
    assert counts == {"sent": 1, "skipped": 0, "failed": 0, "busy": 0}
    assert store.done_calls == [("m1", "sent")]
    assert mailer.sent[0]["to"] == "ira@pochta.ua"
    assert mailer.sent[0]["tag"] == "wishlist-guest"
    assert f"{ORIGIN}/l/shareTokenAAAAAAAAAAAAA/u/mailTokenBBBBBBBBBBBBBB" in mailer.sent[0]["text"]
    assert store.cleaned


@pytest.mark.asyncio
async def test_process_skips_without_sending():
    store, mailer = FakeStore([row(identity={**row()["identity"], "mail_off": True})]), FakeMailer()
    counts = await guest_mail.process(store, mailer, ORIGIN, NOW)
    assert counts["skipped"] == 1
    assert mailer.sent == []
    assert store.done_calls == [("m1", "skipped")]


@pytest.mark.asyncio
async def test_failed_send_is_retried_later():
    store, mailer = FakeStore([row(attempts=2)]), FakeMailer(ok=False)
    counts = await guest_mail.process(store, mailer, ORIGIN, NOW)
    assert counts["failed"] == 1
    assert store.retries == [("m1", 3)]
    assert store.done_calls == []


@pytest.mark.asyncio
async def test_row_taken_by_another_run_is_left_alone():
    store, mailer = FakeStore([row()], taken=False), FakeMailer()
    counts = await guest_mail.process(store, mailer, ORIGIN, NOW)
    assert counts["busy"] == 1
    assert mailer.sent == []


@pytest.mark.asyncio
async def test_log_has_counts_only(caplog):
    caplog.set_level(logging.INFO, logger="jobs.guestmail")
    logger = logging.getLogger("jobs")
    old = logger.propagate
    logger.propagate = True
    try:
        await guest_mail.process(FakeStore([row()]), FakeMailer(), ORIGIN, NOW)
    finally:
        logger.propagate = old
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "guest mail" in joined  # лог є — і в ньому лише лічильники
    for secret in ("ira@pochta.ua", "shareTokenAAAAAAAAAAAAA", "mailTokenBBBBBBBBBBBBBB", "K7M2Q"):
        assert secret not in joined


# ── Сховище ──────────────────────────────────


@pytest.mark.asyncio
@respx.mock
async def test_store_reads_queue_and_takes_rows_atomically():
    due = respx.get("https://ref.supabase.co/rest/v1/guest_mail").mock(return_value=httpx.Response(200, json=[row()]))
    take = respx.patch("https://ref.supabase.co/rest/v1/guest_mail").mock(return_value=httpx.Response(200, json=[{"id": "m1"}]))
    async with httpx.AsyncClient() as client:
        store = GuestMailStore("https://ref.supabase.co", "sb_secret_x", client)
        assert len(await store.due(50, NOW)) == 1
        assert await store.take("m1", NOW)
    params = due.calls[0].request.url.params
    assert params["sent_at"] == "is.null"
    assert params["attempts"] == f"lt.{guest_mail.MAX_ATTEMPTS}"
    assert due.calls[0].request.headers["apikey"] == "sb_secret_x"
    req = take.calls[0].request
    assert req.url.params["sent_at"] == "is.null"
    assert req.url.params["id"] == "eq.m1"
    assert req.headers["prefer"] == "return=representation"


@pytest.mark.asyncio
@respx.mock
async def test_store_touches_only_the_queue():
    """Сервіс пише лише в guest_mail — ні в ідентичності, ні в позначки."""
    route = respx.route(host="ref.supabase.co").mock(return_value=httpx.Response(200, json=[]))
    async with httpx.AsyncClient() as client:
        store = GuestMailStore("https://ref.supabase.co", "sb_secret_x", client)
        await store.due(5, NOW)
        await store.take("m1", NOW)
        await store.done("m1", NOW, "sent")
        await store.retry("m1", 1)
        await store.cleanup(NOW)
    paths = {c.request.url.path for c in route.calls}
    assert paths == {"/rest/v1/guest_mail"}


@pytest.mark.asyncio
@respx.mock
async def test_mailer_passes_tag():
    route = respx.post("https://api.brevo.com/v3/smtp/email").mock(return_value=httpx.Response(201))
    async with httpx.AsyncClient() as client:
        assert await Mailer("xkeysib-x", "hi@wishlist.example", client).send("a@b.c", "s", "<p>h</p>", "t", tag="wishlist-guest")
    assert b'"wishlist-guest"' in route.calls[0].request.content


# ── Відкритий сервіс /wake ───────────────────


def configure(monkeypatch, **extra):
    env = {
        "SUPABASE_URL": "https://ref.supabase.co",
        "SUPABASE_SECRET_KEY": "sb_secret_x",
        "BREVO_API_KEY": "xkeysib-abc",
        "MAIL_FROM": "hi@wishlist.example",
        "APP_ORIGIN": ORIGIN,
        "GUEST_MAIL_WAKE_SECRET": SECRET,
    }
    env.update(extra)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    job_settings.cache_clear()


@pytest.fixture(autouse=True)
def _reset_settings():
    yield
    job_settings.cache_clear()


def test_wake_without_or_with_wrong_secret_does_nothing(monkeypatch):
    configure(monkeypatch)
    called = []

    async def fake_process(*a, **k):
        called.append(1)
        return {}

    monkeypatch.setattr(guest_mail, "process", fake_process)
    with TestClient(mail_main.app) as client:
        assert client.post("/wake").status_code == 401
        assert client.post("/wake", headers={"x-wake-secret": "nope"}).status_code == 401
    assert called == []


def test_wake_without_configured_secret_refuses_everyone(monkeypatch):
    configure(monkeypatch, GUEST_MAIL_WAKE_SECRET="")
    with TestClient(mail_main.app) as client:
        assert client.post("/wake", headers={"x-wake-secret": ""}).status_code == 401


def test_wake_with_secret_but_missing_settings_is_503(monkeypatch):
    configure(monkeypatch, BREVO_API_KEY="")
    with TestClient(mail_main.app) as client:
        assert client.post("/wake", headers={"x-wake-secret": SECRET}).status_code == 503


def test_wake_processes_the_queue(monkeypatch):
    configure(monkeypatch)

    async def fake_process(store, mailer, origin, now, limit=50):
        assert origin == ORIGIN
        return {"sent": 2, "skipped": 0, "failed": 0, "busy": 0}

    monkeypatch.setattr(guest_mail, "process", fake_process)
    with TestClient(mail_main.app) as client:
        res = client.post("/wake", headers={"x-wake-secret": SECRET}, json={"anything": "ignored"})
    assert res.status_code == 200
    assert res.json()["sent"] == 2


def test_health_reveals_no_variable_names(monkeypatch):
    configure(monkeypatch, BREVO_API_KEY="")
    with TestClient(mail_main.app) as client:
        body = client.get("/health").json()
    assert body == {"status": "ok", "service": "wishlist-guestmail", "configured": False}


def test_short_wake_secret_is_a_problem():
    cfg = JobSettings(
        supabase_url="https://ref.supabase.co",
        supabase_secret_key="sb_secret_x",
        brevo_api_key="xkeysib-abc",
        mail_from="hi@wishlist.example",
        app_origin=ORIGIN,
        guest_mail_wake_secret="short",
    )
    assert "GUEST_MAIL_WAKE_SECRET" in cfg.guest_mail_problems
    assert "VAPID_PRIVATE_KEY" not in cfg.guest_mail_problems

"""
Скарги на посилання (ADR-061): лист операторові, черга, сигнал /wake.

Мережі немає: PostgREST і Brevo заступають підмінні класи. Стережемо, що в
листі немає токена посилання й коментар не стає розміткою.
"""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app import guest_mail, mail_main, share_reports
from app.jobs_config import job_settings
from app.share_reports import Report, render

NOW = datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)


def row(**over) -> dict:
    base = {
        "id": "r1",
        "reason": "scam",
        "comment": "Просять гроші <на картку>",
        "locale": "pl",
        "attempts": 0,
        "created_at": "2026-10-20T08:59:00+00:00",
        "owner_id": "owner-uuid",
        "share_id": "share-uuid",
        "share": {"title": "Виграй айфон", "revoked_at": None, "expires_at": None},
    }
    base.update(over)
    return base


def test_letter_has_reason_title_comment_and_lookup_but_no_token():
    letter = render(Report.from_row(row(), NOW))
    assert letter.subject == "Скарга на посилання у Wishlist: Шахрайство"
    for part in ("«Виграй айфон»", "посилання діє", "Просять гроші <на картку>", "share-uuid", "owner-uuid"):
        assert part in letter.text
    assert "&lt;на картку&gt;" in letter.html and "<на картку>" not in letter.html
    assert "select token, title, revoked_at from shares where id = 'share-uuid';" in letter.text
    assert "/l/" not in letter.text and "/s/" not in letter.text


def test_letter_for_dead_or_deleted_share():
    dead = render(Report.from_row(row(share={"title": "X", "revoked_at": "2026-10-19T00:00:00Z", "expires_at": None}), NOW))
    assert "вже не діє" in dead.text
    gone = render(Report.from_row(row(share_id=None, share=None, comment=None), NOW))
    assert "посилання вже видалено" in gone.text
    assert "Коментаря немає." in gone.text
    assert "from lists where owner_id = 'owner-uuid'" in gone.text


class FakeStore:
    def __init__(self, rows, taken=True):
        self.rows, self.taken = rows, taken
        self.done_ids, self.retries, self.cleaned = [], [], False

    async def due(self, limit, now):
        return self.rows[:limit]

    async def take(self, report_id, now):
        return self.taken

    async def done(self, report_id, now):
        self.done_ids.append(report_id)

    async def retry(self, report_id, attempts):
        self.retries.append((report_id, attempts))

    async def cleanup(self, now):
        self.cleaned = True


class FakeMailer:
    def __init__(self, ok=True):
        self.ok, self.sent = ok, []

    async def send(self, to, subject, html, text, tag="x"):
        self.sent.append({"to": to, "subject": subject, "tag": tag})
        return self.ok


@pytest.mark.asyncio
async def test_process_sends_to_operator_and_marks_done():
    store, mailer = FakeStore([row(), row(id="r2", reason="other")]), FakeMailer()
    counts = await share_reports.process(store, mailer, to="hi@wishlist.example", now=NOW)
    assert counts == {"reports": 2, "reports_failed": 0}
    assert [m["to"] for m in mailer.sent] == ["hi@wishlist.example"] * 2
    assert mailer.sent[0]["tag"] == "wishlist-report"
    assert store.done_ids == ["r1", "r2"] and store.cleaned


@pytest.mark.asyncio
async def test_process_retries_when_brevo_fails_and_skips_taken():
    store, mailer = FakeStore([row(attempts=2)]), FakeMailer(ok=False)
    counts = await share_reports.process(store, mailer, to="hi@w.example", now=NOW)
    assert counts["reports_failed"] == 1 and store.retries == [("r1", 3)]
    busy = FakeStore([row()], taken=False)
    await share_reports.process(busy, FakeMailer(), to="hi@w.example", now=NOW)
    assert busy.done_ids == []


SECRET = "wake-secret-0123456789abcdef-0123456789"


@pytest.fixture(autouse=True)
def _reset_settings():
    yield
    job_settings.cache_clear()


def configure(monkeypatch):
    for k, v in {
        "SUPABASE_URL": "https://ref.supabase.co",
        "SUPABASE_SECRET_KEY": "sb_secret_x",
        "BREVO_API_KEY": "xkeysib-abc",
        "MAIL_FROM": "hi@wishlist.example",
        "APP_ORIGIN": "https://wishlist.example",
        "GUEST_MAIL_WAKE_SECRET": SECRET,
    }.items():
        monkeypatch.setenv(k, v)
    job_settings.cache_clear()


def test_wake_processes_reports_after_guest_mail(monkeypatch):
    configure(monkeypatch)
    order = []

    async def fake_guest(*a, **k):
        order.append("guest")
        return {"sent": 0, "skipped": 0, "failed": 0, "busy": 0}

    async def fake_reports(store, mailer, to, now, limit=20):
        order.append(("reports", to))
        return {"reports": 1, "reports_failed": 0}

    monkeypatch.setattr(guest_mail, "process", fake_guest)
    monkeypatch.setattr(share_reports, "process", fake_reports)
    with TestClient(mail_main.app) as client:
        res = client.post("/wake", headers={"x-wake-secret": SECRET}, json={})
    assert res.status_code == 200
    assert res.json()["reports"] == 1
    assert order == ["guest", ("reports", "hi@wishlist.example")]

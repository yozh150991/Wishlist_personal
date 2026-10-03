"""
Сповіщення власника (ADR-049): події, тиша, об'єднання, push і листи.

Мережі тут немає: служби push і Brevo заступає respx, базу — підмінний
Store. Окремо перевіряємо, що сервіс ходить лише в дозволені таблиці й не
просить токенів посилань, і що push іде лише на відомі служби push.
"""

import base64
import json
import re
import string
from datetime import date, datetime, timedelta, timezone

import http_ece
import httpx
import pytest
import respx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app import jobs_notify as notify
from app.jobs_config import JobSettings, job_settings
from app.jobs_mail import Mailer
from app.jobs_main import app
from app.jobs_push import Pusher, Subscription, encrypt, endpoint_allowed
from app.jobs_store import KINDS, NotifyStore, Owner, Recipient
from app.jobs_texts import LOCALES, TEXTS, format_date, format_money

NOW = datetime(2026, 10, 19, 8, 0, tzinfo=timezone.utc)  # 10:00 у Варшаві
TODAY = date(2026, 10, 19)
FCM = "https://fcm.googleapis.com/fcm/send/abc"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def owner(**prefs: tuple[bool, bool]) -> Owner:
    full = {k: prefs.get(k, (False, False)) for k in KINDS}
    return Owner(id="o1", time_zone="Europe/Warsaw", prefs=full, last_sent_at=None)


def receiver() -> tuple[ec.EllipticCurvePrivateKey, Subscription]:
    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    auth = b"0123456789abcdef"
    return key, Subscription("s1", FCM, b64url(public), b64url(auth))


def vapid_key() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return b64url(key.private_numbers().private_value.to_bytes(32, "big"))


LISTS = [
    {"id": "L1", "title": "День народження", "currency": "UAH", "event_date": "2026-10-18", "is_archived": False, "repeats_yearly": False},
    {"id": "L2", "title": "Новий рік", "currency": "PLN", "event_date": "2025-11-10", "is_archived": True, "repeats_yearly": True},
    {"id": "L3", "title": "Архів", "currency": "UAH", "event_date": "2026-10-18", "is_archived": True, "repeats_yearly": False},
]
ITEMS = [
    {"id": "I1", "list_id": "L1", "title": "Лампа", "url": "https://shop.ua/lampa", "price": "1240.00", "link_status": "gone", "link_price": None, "link_currency": None},
    {"id": "I2", "list_id": "L1", "title": "Плед", "url": "https://shop.ua/pled", "price": "1000.00", "link_status": "ok", "link_price": "1150.00", "link_currency": "UAH"},
    {"id": "I3", "list_id": "L3", "title": "У архіві", "url": "https://shop.ua/x", "price": None, "link_status": "gone", "link_price": None, "link_currency": None},
]
SHARES = [{"id": "S1", "title": "Для родини", "expires_at": "2026-10-20T21:59:59+00:00"}]


class TestTexts:
    def test_every_locale_has_every_key_with_the_same_placeholders(self):
        fields = lambda s: {f for _, f, _, _ in string.Formatter().parse(s) if f}  # noqa: E731
        for key, uk in TEXTS["uk"].items():
            for loc in LOCALES:
                assert key in TEXTS[loc], (loc, key)
                assert fields(TEXTS[loc][key]) == fields(uk), (loc, key)

    def test_money_and_dates(self):
        assert format_money(139000, "UAH", "uk") == "1 390 грн"
        assert format_money(139050, "PLN", "pl") == "1 390,50 zł"
        assert format_money(139050, "USD", "en") == "$1,390.50"
        assert format_money(139000, "UAH", "en") == "UAH 1,390"
        assert format_date(date(2026, 10, 18), "uk") == "18 жовтня"
        assert format_date(date(2026, 10, 18), "pl") == "18 października"
        assert format_date(date(2026, 10, 18), "xx") == "18 жовтня"


class TestEvents:
    def test_after_event_from_the_next_day_for_a_week_not_archived(self):
        found = notify.find_events(owner(after_event=(True, False)), LISTS, [], [], today=TODAY, logged=set())
        assert [(e.kind, e.subject_id, e.occurrence, e.path) for e in found] == [
            ("after_event", "L1", "2026-10-18", "/lists/L1")
        ]
        assert notify.find_events(owner(after_event=(True, False)), LISTS, [], [], today=date(2026, 10, 18), logged=set()) == []
        assert notify.find_events(owner(after_event=(True, False)), LISTS, [], [], today=date(2026, 10, 26), logged=set()) == []

    def test_yearly_a_month_before_the_anniversary_even_in_archive(self):
        found = notify.find_events(owner(yearly=(True, False)), LISTS, [], [], today=TODAY, logged=set())
        assert [(e.kind, e.subject_id, e.occurrence) for e in found] == [("yearly", "L2", "2026-11-10")]
        # Список, день якого попереду, — сам і є повтор: нагадування немає.
        future = [{**LISTS[1], "event_date": "2026-11-10"}]
        assert notify.find_events(owner(yearly=(True, False)), future, [], [], today=TODAY, logged=set()) == []

    def test_link_and_price_only_in_live_lists(self):
        found = notify.find_events(owner(link=(True, False), price=(True, False)), LISTS, ITEMS, [], today=TODAY, logged=set())
        kinds = sorted((e.kind, e.subject_id) for e in found)
        assert kinds == [("link", "I1"), ("price", "I2")]
        link = next(e for e in found if e.kind == "link")
        assert link.occurrence.startswith("gone:") and link.text_key == "link_gone"

    def test_new_address_is_a_new_occurrence(self):
        a = notify.find_events(owner(link=(True, False)), LISTS, ITEMS[:1], [], today=TODAY, logged=set())[0]
        moved = {**ITEMS[0], "url": "https://other.ua/lampa"}
        b = notify.find_events(owner(link=(True, False)), LISTS, [moved], [], today=TODAY, logged=set())[0]
        assert a.occurrence != b.occurrence

    @pytest.mark.parametrize(
        ("price", "shop", "currency", "expected"),
        [
            ("1000.00", "1150.00", "UAH", (115000, 100000)),
            ("1240.00", "1390.00", "UAH", None),  # 12 % — лише підказка в застосунку
            (None, "500.00", "UAH", None),  # своєї ціни немає — порівнювати нічого
            ("100.00", "25.00", "EUR", None),  # інша валюта
            ("100.00", "0", "UAH", None),
        ],
    )
    def test_price_change_matches_the_app_rule(self, price, shop, currency, expected):
        item = {"price": price, "link_price": shop, "link_currency": currency}
        assert notify.price_change(item, "UAH") == expected

    def test_share_date_in_the_owner_zone(self):
        found = notify.find_events(owner(share=(True, False)), LISTS, [], SHARES, today=TODAY, logged=set())
        assert len(found) == 1 and found[0].path == "/shares"
        title, body = notify.render(found[0], "uk")
        assert "20 жовтня" in body  # 23:59:59 у Варшаві — ще 20-те

    def test_already_sent_and_switched_off_kinds_are_skipped(self):
        everything = owner(**{k: (True, True) for k in KINDS})
        all_found = notify.find_events(everything, LISTS, ITEMS, SHARES, today=TODAY, logged=set())
        logged = {e.key for e in all_found}
        assert notify.find_events(everything, LISTS, ITEMS, SHARES, today=TODAY, logged=logged) == []
        assert notify.find_events(owner(), LISTS, ITEMS, SHARES, today=TODAY, logged=set()) == []


class TestMessages:
    def test_one_event_is_specific_many_are_one_digest(self):
        found = notify.find_events(owner(link=(True, False), after_event=(True, False)), LISTS, ITEMS, [], today=TODAY, logged=set())
        single = notify.push_message(found[:1], "uk")
        assert single["title"] == "Як минуло свято?" and single["url"] == "/lists/L1?design=v2"
        digest = notify.push_message(found, "uk")
        assert digest["title"] == "Нове у твоїх списках: 2"
        assert "«Лампа»" in digest["body"] and digest["url"] == "/lists/L1?design=v2"

    def test_email_escapes_names_and_links_to_settings(self):
        evil = [{**LISTS[0], "title": '<script>alert(1)</script>'}]
        found = notify.find_events(owner(after_event=(False, True)), evil, [], [], today=TODAY, logged=set())
        subject, html_body, text_body = notify.email_message(found, "pl", "https://wishlist.example")
        assert subject == "Jak minęło święto?"
        assert "<script>" not in html_body and "&lt;script&gt;" in html_body
        # Сповіщення — функція v2, а вибір версії живе в браузері: без параметра
        # пошта на телефоні відкрила б v1, де картки «Сповіщення» немає.
        assert 'href="https://wishlist.example/lists/L1?design=v2"' in html_body
        assert "https://wishlist.example/settings?design=v2#notifications" in html_body
        assert "https://wishlist.example/lists/L1?design=v2" in text_body

    def test_no_gendered_verbs_in_owner_texts(self):
        # Власник — «ти» без роду: «отримав», «зробила», «dostałeś» — ні.
        joined = " ".join(TEXTS["uk"].values()) + " " + " ".join(TEXTS["pl"].values())
        for word in ("отримав", "отримала", "зробив", "зробила", "dostałeś", "dostałaś", "zrobiłeś", "zrobiłaś"):
            assert word not in joined


class TestPush:
    @pytest.mark.parametrize(
        "endpoint",
        [
            "https://fcm.googleapis.com/fcm/send/x",
            "https://updates.push.services.mozilla.com/wpush/v2/x",
            "https://web.push.apple.com/x",
            "https://wns2-par02p.notify.windows.com/w/?token=x",
        ],
    )
    def test_known_push_services_are_allowed(self, endpoint):
        assert endpoint_allowed(endpoint)

    @pytest.mark.parametrize(
        "endpoint",
        [
            "http://fcm.googleapis.com/fcm/send/x",
            "https://169.254.169.254/computeMetadata/v1/",
            "https://fcm.googleapis.com.evil.example/x",
            "https://evilfcm.googleapis.com.example/x",
            "https://fcm.googleapis.com:8443/x",
            "https://user:pw@fcm.googleapis.com/x",
            "https://localhost/x",
            "not a url",
        ],
    )
    def test_anything_else_is_blocked(self, endpoint):
        assert not endpoint_allowed(endpoint)

    def test_only_the_browser_can_read_the_payload(self):
        key, sub = receiver()
        body = encrypt(b'{"title":"x"}', sub)
        assert http_ece.decrypt(body, private_key=key, auth_secret=b"0123456789abcdef", version="aes128gcm") == b'{"title":"x"}'

    @respx.mock
    async def test_send_signs_with_vapid_and_reports_outcome(self):
        _, sub = receiver()
        route = respx.post(FCM).mock(side_effect=[httpx.Response(201), httpx.Response(410), httpx.Response(500)])
        async with httpx.AsyncClient() as client:
            pusher = Pusher(vapid_key(), "wishlist@example.com", client)
            assert await pusher.send(sub, {"title": "t", "body": "b", "url": "/lists"}) == "ok"
            assert await pusher.send(sub, {"title": "t"}) == "gone"
            assert await pusher.send(sub, {"title": "t"}) == "failed"
        request = route.calls[0].request
        assert request.headers["content-encoding"] == "aes128gcm"
        assert request.headers["ttl"] == "86400"
        auth = request.headers["authorization"]
        assert re.fullmatch(r"vapid t=[\w.-]+,k=[\w-]+", auth)
        claims_part = auth.split("t=")[1].split(",")[0].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(claims_part + "=" * (-len(claims_part) % 4)))
        assert claims["aud"] == "https://fcm.googleapis.com" and claims["sub"] == "mailto:wishlist@example.com"

    @respx.mock
    async def test_broken_browser_keys_or_address_are_blocked_not_fatal(self):
        _, sub = receiver()
        broken_keys = Subscription("s3", FCM, "A" * 20, "A" * 8)
        tab_in_host = Subscription("s4", "https://fcm.googleapis.com\t/x", sub.p256dh, sub.auth)
        async with httpx.AsyncClient() as client:
            pusher = Pusher(vapid_key(), "w@example.com", client)
            assert await pusher.send(broken_keys, {"title": "t"}) == "blocked"
            assert await pusher.send(tab_in_host, {"title": "t"}) in ("blocked", "failed")
        assert not respx.calls

    @respx.mock
    async def test_blocked_endpoint_gets_no_request(self):
        _, sub = receiver()
        evil = Subscription("s2", "https://169.254.169.254/x", sub.p256dh, sub.auth)
        async with httpx.AsyncClient() as client:
            assert await Pusher(vapid_key(), "w@example.com", client).send(evil, {"title": "t"}) == "blocked"
        assert not respx.calls


class TestMail:
    @respx.mock
    async def test_send_and_ping(self):
        sent = respx.post("https://api.brevo.com/v3/smtp/email").mock(return_value=httpx.Response(201, json={"messageId": "x"}))
        respx.get("https://api.brevo.com/v3/account").mock(side_effect=[httpx.Response(200, json={}), httpx.Response(401)])
        async with httpx.AsyncClient() as client:
            mailer = Mailer("xkeysib-test", "wishlist@example.com", client)
            assert await mailer.send("owner@example.com", "S", "<p>h</p>", "t") is True
            assert await mailer.ping() == "ok"
            assert await mailer.ping() == "refused"
        request = sent.calls[0].request
        assert request.headers["api-key"] == "xkeysib-test"
        body = json.loads(request.content)
        assert body["sender"] == {"email": "wishlist@example.com", "name": "Wishlist"}
        assert body["to"] == [{"email": "owner@example.com"}]


class FakeStore:
    def __init__(self, owners, *, subs=None, recipient=Recipient("owner@example.com", "uk"), logged=None):
        self._owners = owners
        self._subs = subs or []
        self._recipient = recipient
        self._logged = logged or set()
        self.logged_rows: list[dict] = []
        self.marked: list[datetime] = []
        self.dropped: list[str] = []
        self.touched: list[str] = []

    async def owners(self):
        return self._owners

    async def lists(self, owner_id):
        return LISTS

    async def items(self, owner_id):
        return ITEMS

    async def shares(self, owner_id, after, until):
        return SHARES

    async def logged(self, owner_id, subject_ids):
        return {k for k in self._logged if k[1] in subject_ids}

    async def subscriptions(self, owner_id):
        return self._subs

    async def recipient(self, owner_id):
        return self._recipient

    async def log(self, owner_id, rows):
        self.logged_rows.extend(rows)

    async def mark_sent(self, owner_id, at):
        self.marked.append(at)

    async def drop_subscription(self, sub_id):
        self.dropped.append(sub_id)

    async def touch_subscription(self, sub_id, at):
        self.touched.append(sub_id)


class FakePusher:
    def __init__(self, results):
        self.results = list(results)
        self.messages: list[dict] = []

    async def send(self, sub, message):
        self.messages.append(message)
        return self.results.pop(0)


class FakeMailer:
    def __init__(self, ok=True):
        self.ok = ok
        self.sent: list[tuple[str, str]] = []
        self.pings = 0

    async def send(self, to, subject, html, text):
        self.sent.append((to, subject))
        return self.ok

    async def ping(self):
        self.pings += 1
        return "ok"


def sub(i: str) -> Subscription:
    return Subscription(i, f"{FCM}/{i}", "p" * 87, "a" * 22)


class TestRun:
    async def test_digest_by_push_and_email_by_preference(self):
        store = FakeStore([owner(after_event=(True, True), link=(True, False))], subs=[sub("a"), sub("b")])
        pusher, mailer = FakePusher(["ok", "gone"]), FakeMailer()
        summary = await notify.run(store, pusher, mailer, origin="https://w.example", now=NOW)

        assert len(pusher.messages) == 2 and pusher.messages[0]["title"] == "Нове у твоїх списках: 2"
        assert mailer.sent == [("owner@example.com", "Як минуло свято?")]  # у листі — лише те, що просили листом
        assert store.dropped == ["b"] and store.touched == ["a"]
        channels = {r["kind"]: r["channels"] for r in store.logged_rows}
        assert channels == {"after_event": ["push", "email"], "link": ["push"]}
        assert store.marked == [NOW]
        assert summary["push"] == 1 and summary["email"] == 1 and summary["events"] == 2

    async def test_quiet_hours_by_the_owner_clock(self):
        store = FakeStore([owner(after_event=(True, True))], subs=[sub("a")])
        late = datetime(2026, 10, 19, 20, 30, tzinfo=timezone.utc)  # 22:30 у Варшаві
        summary = await notify.run(store, FakePusher([]), FakeMailer(), origin="https://w.example", now=late)
        assert summary == {"quiet": 1} and store.logged_rows == []

    async def test_three_hours_between_notifications(self):
        recent = Owner("o1", "Europe/Warsaw", owner(after_event=(True, False)).prefs, NOW - timedelta(hours=1))
        store = FakeStore([recent], subs=[sub("a")])
        assert await notify.run(store, FakePusher([]), FakeMailer(), origin="https://w.example", now=NOW) == {"waiting": 1}

    async def test_nowhere_to_deliver_is_recorded_once_not_retried_hourly(self):
        store = FakeStore([owner(after_event=(True, False))], subs=[])
        summary = await notify.run(store, FakePusher([]), FakeMailer(), origin="https://w.example", now=NOW)
        assert store.logged_rows == [{"kind": "after_event", "subject_id": "L1", "occurrence": "2026-10-18", "channels": []}]
        assert store.marked == [] and summary["dropped"] == 1

    async def test_failed_delivery_is_retried_later(self):
        store = FakeStore([owner(after_event=(True, True))], subs=[sub("a")])
        await notify.run(store, FakePusher(["failed"]), FakeMailer(ok=False), origin="https://w.example", now=NOW)
        assert store.logged_rows == [] and store.marked == []

    async def test_unconfirmed_email_gets_no_letter(self):
        store = FakeStore([owner(after_event=(False, True))], recipient=Recipient(None, "pl"))
        mailer = FakeMailer()
        await notify.run(store, FakePusher([]), mailer, origin="https://w.example", now=NOW)
        assert mailer.sent == [] and store.logged_rows[0]["channels"] == []

    async def test_old_zone_names_keep_quiet_hours(self):
        # Chrome в Україні досі каже `Europe/Kiev`; без tzdata це мовчки був би UTC.
        kyiv = Owner("o1", "Europe/Kiev", owner(after_event=(True, False)).prefs, None)
        late = datetime(2026, 10, 19, 19, 30, tzinfo=timezone.utc)  # 22:30 у Києві
        store = FakeStore([kyiv], subs=[sub("a")])
        assert await notify.run(store, FakePusher([]), FakeMailer(), origin="https://w.example", now=late) == {"quiet": 1}

    async def test_scheduler_drift_does_not_delay_by_an_hour(self):
        almost = Owner("o1", "Europe/Warsaw", owner(after_event=(True, False)).prefs, NOW - timedelta(hours=2, minutes=59, seconds=50))
        store = FakeStore([almost], subs=[sub("a")])
        summary = await notify.run(store, FakePusher(["ok"]), FakeMailer(), origin="https://w.example", now=NOW)
        assert summary["push"] == 1

    async def test_one_broken_owner_does_not_stop_the_rest(self):
        class Flaky(FakeStore):
            async def lists(self, owner_id):
                if owner_id == "bad":
                    raise httpx.HTTPStatusError("500", request=httpx.Request("GET", "https://x"), response=httpx.Response(500))
                return LISTS

        bad = Owner("bad", "Europe/Warsaw", owner(after_event=(True, False)).prefs, None)
        good = Owner("good", "Europe/Warsaw", owner(after_event=(True, False)).prefs, None)
        store = Flaky([bad, good], subs=[sub("a")])
        summary = await notify.run(store, FakePusher(["ok"]), FakeMailer(), origin="https://w.example", now=NOW)
        assert summary["errors"] == 1 and summary["push"] == 1

    async def test_non_push_address_is_removed_and_the_event_not_retried(self):
        evil = Subscription("x", "https://169.254.169.254/x", "p" * 87, "a" * 22)
        store = FakeStore([owner(after_event=(True, False))], subs=[evil])
        summary = await notify.run(store, FakePusher([]), FakeMailer(), origin="https://w.example", now=NOW)
        assert store.dropped == ["x"] and summary["push_blocked"] == 1
        assert store.logged_rows[0]["channels"] == []  # нікуди — записано, не щогодини

    async def test_auth_hiccup_skips_the_owner_without_dropping_mail(self):
        store = FakeStore([owner(after_event=(False, True))], recipient=None)
        summary = await notify.run(store, FakePusher([]), FakeMailer(), origin="https://w.example", now=NOW)
        assert summary["auth_unavailable"] == 1 and store.logged_rows == []

    async def test_daily_keepalive_for_the_brevo_key(self):
        mailer = FakeMailer()
        await notify.run(FakeStore([]), FakePusher([]), mailer, origin="https://w.example", now=NOW.replace(hour=3))
        await notify.run(FakeStore([]), FakePusher([]), mailer, origin="https://w.example", now=NOW)
        assert mailer.pings == 1


class TestNotifyStore:
    @respx.mock
    async def test_reads_only_its_tables_without_share_tokens_and_secret_only_in_apikey(self):
        base = "https://ref.supabase.co"
        seen: list[httpx.Request] = []

        def record(request):
            seen.append(request)
            path = request.url.path
            if path.endswith("/notification_settings"):
                return httpx.Response(200, json=[{"owner_id": "o1", "time_zone": "Europe/Warsaw", "after_event_push": True}])
            if path.startswith("/auth/v1/admin/users/"):
                return httpx.Response(200, json={"email": "o@example.com", "email_confirmed_at": None, "user_metadata": {"locale": "pl"}})
            return httpx.Response(200, json=[])

        respx.route(host="ref.supabase.co").mock(side_effect=record)
        async with httpx.AsyncClient() as client:
            store = NotifyStore(base, "sb_secret_test", client)
            owners = await store.owners()
            await store.lists("o1")
            await store.items("o1")
            await store.shares("o1", NOW, NOW + timedelta(days=3))
            await store.logged("o1", [f"id{i}" for i in range(150)])
            await store.subscriptions("o1")
            who = await store.recipient("o1")

        assert owners[0].prefs["after_event"] == (True, False) and owners[0].prefs["price"] == (False, False)
        assert who == Recipient(None, "pl")  # непідтверджена пошта — листів немає
        paths = {r.url.path for r in seen}
        allowed = {
            "/rest/v1/notification_settings", "/rest/v1/lists", "/rest/v1/items", "/rest/v1/shares",
            "/rest/v1/notification_log", "/rest/v1/push_subscriptions", "/auth/v1/admin/users/o1",
        }
        assert paths <= allowed
        for r in seen:
            assert r.headers["apikey"] == "sb_secret_test" and "authorization" not in r.headers
            assert "claims" not in str(r.url) and "guest" not in str(r.url)
        shares = next(r for r in seen if r.url.path.endswith("/shares"))
        assert "token" not in shares.url.params["select"]
        # Журнал — лише для предметів цього запуску, частинами по 100.
        logs = [r for r in seen if r.url.path.endswith("/notification_log")]
        assert len(logs) == 2 and logs[0].url.params["subject_id"].startswith("in.(")


class TestApp:
    def test_notify_without_token_is_refused(self):
        with TestClient(app) as client:
            assert client.post("/jobs/notify").status_code == 401

    def test_notify_without_keys_is_503_and_health_names_them(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://ref.supabase.co")
        monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_x")
        job_settings.cache_clear()
        try:
            with TestClient(app) as client:
                res = client.post("/jobs/notify", headers={"Authorization": "Bearer " + "x" * 40})
                health = client.get("/health").json()
            assert res.status_code == 503 and res.json()["detail"] == "notify_not_configured"
            assert health["configured"] is True and health["notify_configured"] is False
            assert health["notify_problems"] == ["BREVO_API_KEY", "VAPID_PRIVATE_KEY", "MAIL_FROM", "APP_ORIGIN"]
            assert health["brevo"] == "not_configured"
        finally:
            job_settings.cache_clear()

    def test_notify_settings_accept_the_real_shapes(self):
        cfg = JobSettings(
            supabase_url="https://r.supabase.co",
            supabase_secret_key="sb_secret_x",
            brevo_api_key="xkeysib-" + "a" * 64 + "-" + "b" * 16,
            vapid_private_key=vapid_key(),
            mail_from="me@gmail.com",
            app_origin="https://wishlist-personal.vercel.app/",
        )
        assert cfg.notify_problems == [] and cfg.notify_ready

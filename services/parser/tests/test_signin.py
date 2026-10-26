"""
Вхід із нового пристрою (ADR-074). Бази й мережі немає: сховище, push і
пошта — підробки в пам'яті. Перевіряємо, що з User-Agent виходить «браузер ·
система», що перший запуск і перший пристрій мовчать, що новий пристрій дає
лист одразу (навіть уночі) і що невдалий лист не робить пристрій відомим.
"""

import logging
from datetime import datetime, timedelta, timezone

import pytest

from app import jobs_signin as signin
from app.jobs_push import Subscription
from app.jobs_store import Recipient, SignInPrefs

NOW = datetime(2026, 10, 25, 2, 30, tzinfo=timezone.utc)  # 03:30 у Варшаві — «тиша» для звичайних сповіщень
A = "a0000000-0000-4000-8000-00000000000a"
B = "b0000000-0000-4000-8000-00000000000b"

ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
ANDROID_NEW = ANDROID.replace("131.0.0.0", "132.0.6834.83")
WINDOWS_FF = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0"


class TestDevice:
    @pytest.mark.parametrize(
        ("ua", "device"),
        [
            (ANDROID, "Chrome · Android"),
            (WINDOWS_FF, "Firefox · Windows"),
            ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", "Safari · iOS"),
            ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1", "Chrome · iOS"),
            ("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1", "Safari · iPadOS"),
            ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Safari · macOS"),
            ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0", "Edge · Windows"),
            ("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0", "Opera · Windows"),
            ("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", "Samsung Internet · Android"),
            ("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Chrome · ChromeOS"),
            ("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox · Linux"),
            ("curl/8.4.0", "curl"),
            ("python-httpx/0.27.0", "python-httpx"),
            ("", signin.UNKNOWN),
            (None, signin.UNKNOWN),
            ("???", signin.UNKNOWN),
        ],
    )
    def test_browser_and_system(self, ua, device):
        assert signin.device_of(ua) == device

    def test_browser_update_is_the_same_device(self):
        assert signin.device_of(ANDROID) == signin.device_of(ANDROID_NEW)


class FakeStore:
    def __init__(self, sign_ins, known=None, prefs=None, recipient=Recipient("owner@test.local", "uk"), subs=None):
        self._sign_ins = sign_ins
        self.known = {k: set(v) for k, v in (known or {}).items()}
        self._prefs = prefs or {}
        self._recipient = recipient
        self._subs = subs or []
        self.since = None
        self.remembered: list[tuple[str, list[str]]] = []

    async def any_known_devices(self):
        return any(self.known.values())

    async def recent_sign_ins(self, since, limit):
        self.since = since
        return [s for s in self._sign_ins if s.created_at > since]

    async def known_devices(self, user_ids):
        return {u: set(self.known.get(u, set())) for u in user_ids if u in self.known}

    async def remember_devices(self, user_id, devices):
        self.remembered.append((user_id, list(devices)))
        self.known.setdefault(user_id, set()).update(devices)

    async def signin_prefs(self, user_ids):
        return {u: p for u, p in self._prefs.items() if u in user_ids}

    async def subscriptions(self, owner_id):
        return list(self._subs)

    async def recipient(self, owner_id):
        return self._recipient

    async def drop_subscription(self, sub_id):
        pass

    async def touch_subscription(self, sub_id, at):
        pass


class FakeMailer:
    def __init__(self, ok=True):
        self.ok = ok
        self.sent: list[tuple[str, str, str, str]] = []

    async def send(self, to, subject, html, text):
        self.sent.append((to, subject, html, text))
        return self.ok


class FakePusher:
    def __init__(self):
        self.sent: list[dict] = []

    async def send(self, sub, message):
        self.sent.append(message)
        return "ok"


def sign_in(user, ua, minutes_ago=20, ip="203.0.113.7", sid="s1"):
    return signin.SignIn(sid, user, NOW - timedelta(minutes=minutes_ago), ua, ip)


async def go(store, mailer=None, pusher=None):
    return await signin.run(store, pusher or FakePusher(), mailer or FakeMailer(), origin="https://wish.test", now=NOW)


class TestRun:
    async def test_first_run_remembers_every_live_session_silently(self):
        store = FakeStore([sign_in(A, ANDROID, minutes_ago=60 * 24 * 20), sign_in(A, WINDOWS_FF, sid="s2")])
        mailer = FakeMailer()
        summary = await go(store, mailer)
        assert store.since == signin.EPOCH
        assert store.known[A] == {"Chrome · Android", "Firefox · Windows"}
        assert mailer.sent == []
        assert summary["signin_first"] == 2

    async def test_first_device_of_an_account_is_silent(self):
        store = FakeStore([sign_in(B, ANDROID)], known={A: {"Chrome · Android"}})
        mailer = FakeMailer()
        await go(store, mailer)
        assert store.since == NOW - signin.WINDOW
        assert store.known[B] == {"Chrome · Android"}
        assert mailer.sent == []

    async def test_known_device_after_browser_update_is_silent(self):
        store = FakeStore([sign_in(A, ANDROID_NEW)], known={A: {"Chrome · Android"}})
        mailer = FakeMailer()
        assert await go(store, mailer) == {}
        assert mailer.sent == []
        assert store.remembered == []

    async def test_new_device_mails_at_once_even_at_night(self):
        store = FakeStore(
            [sign_in(A, WINDOWS_FF)],
            known={A: {"Chrome · Android"}},
            prefs={A: SignInPrefs(time_zone="Europe/Warsaw")},
        )
        mailer = FakeMailer()
        summary = await go(store, mailer)
        assert summary["signin_alerts"] == 1
        to, subject, html, text = mailer.sent[0]
        assert to == "owner@test.local"
        assert subject == "Вхід у Wishlist із нового пристрою"
        assert "Firefox · Windows" in text and "IP 203.0.113.7" in text
        # 02:10 UTC → 03:10 у Варшаві (зимовий час з 25 жовтня).
        assert "25 жовтня, 03:10" in text and "Europe/Warsaw" in text
        assert "https://wish.test/reset" in text and "https://wish.test/settings#security" in text
        assert "<script" not in html
        assert "Firefox · Windows" in store.known[A]

    async def test_no_settings_row_still_mails(self):
        store = FakeStore([sign_in(A, WINDOWS_FF)], known={A: {"Chrome · Android"}})
        mailer = FakeMailer()
        await go(store, mailer)
        assert len(mailer.sent) == 1
        assert "UTC" in mailer.sent[0][3]

    async def test_failed_mail_keeps_device_new_for_the_next_run(self):
        store = FakeStore([sign_in(A, WINDOWS_FF)], known={A: {"Chrome · Android"}})
        summary = await go(store, FakeMailer(ok=False))
        assert summary["signin_retry"] == 1
        assert "Firefox · Windows" not in store.known[A]
        mailer = FakeMailer()
        await go(store, mailer)
        assert len(mailer.sent) == 1
        assert "Firefox · Windows" in store.known[A]

    async def test_turned_off_remembers_without_mail(self):
        store = FakeStore(
            [sign_in(A, WINDOWS_FF)],
            known={A: {"Chrome · Android"}},
            prefs={A: SignInPrefs(push=False, email=False)},
        )
        mailer = FakeMailer()
        summary = await go(store, mailer)
        assert mailer.sent == []
        assert summary["signin_off"] == 1
        assert "Firefox · Windows" in store.known[A]

    async def test_unconfirmed_email_and_no_push_is_nowhere_not_retry(self):
        store = FakeStore([sign_in(A, WINDOWS_FF)], known={A: {"Chrome · Android"}}, recipient=Recipient(None, "pl"))
        summary = await go(store)
        assert summary["signin_nowhere"] == 1
        assert "Firefox · Windows" in store.known[A]

    async def test_auth_down_waits_for_the_next_run(self):
        store = FakeStore([sign_in(A, WINDOWS_FF)], known={A: {"Chrome · Android"}}, recipient=None)
        summary = await go(store)
        assert summary["signin_auth_unavailable"] == 1
        assert "Firefox · Windows" not in store.known[A]

    async def test_push_when_turned_on(self):
        sub = Subscription("sub1", "https://fcm.googleapis.com/fcm/send/x", "B" + "A" * 86, "a" * 22)
        store = FakeStore(
            [sign_in(A, WINDOWS_FF)],
            known={A: {"Chrome · Android"}},
            prefs={A: SignInPrefs(push=True, email=False)},
            subs=[sub],
            recipient=Recipient("owner@test.local", "en"),
        )
        pusher = FakePusher()
        mailer = FakeMailer()
        await go(store, mailer, pusher)
        assert mailer.sent == []
        assert pusher.sent == [
            {"title": "New device signed in to Wishlist", "body": "Firefox · Windows", "url": "/settings#security", "tag": "wishlist-signin"}
        ]

    async def test_several_new_devices_one_mail(self):
        store = FakeStore(
            [sign_in(A, WINDOWS_FF, sid="s1"), sign_in(A, "curl/8.4.0", minutes_ago=5, ip=None, sid="s2")],
            known={A: {"Chrome · Android"}},
        )
        mailer = FakeMailer()
        await go(store, mailer)
        assert len(mailer.sent) == 1
        text = mailer.sent[0][3]
        assert text.index("Firefox · Windows") < text.index("curl")

    async def test_log_has_counts_only(self, caplog):
        caplog.set_level(logging.INFO, logger="jobs.signin")
        store = FakeStore([sign_in(A, WINDOWS_FF)], known={A: {"Chrome · Android"}})
        await go(store)
        assert "203.0.113.7" not in caplog.text
        assert "owner@test.local" not in caplog.text
        assert "Firefox" not in caplog.text

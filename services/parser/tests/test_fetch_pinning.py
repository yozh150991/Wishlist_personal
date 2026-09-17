"""
Зʼєднання йде на вже перевірену IP.

Без піна перевірка й зʼєднання робили два окремі резолви DNS, і домен
атакуючого міг віддати публічну адресу на перший запит і 169.254.169.254 —
на другий (DNS rebinding). Тести підміняють і резолв, і транспорт, тож
мережа тут не потрібна.
"""

import httpx
import pytest
from fastapi import HTTPException

from app import fetcher

HTML = {"content-type": "text/html; charset=utf-8"}


def fake_dns(monkeypatch, mapping: dict[str, list[str]]):
    """Підміняє getaddrinfo: хост → список адрес."""

    def getaddrinfo(host, *_args, **_kwargs):
        addresses = mapping.get(host)
        if addresses is None:
            raise OSError(f"немає запису для {host}")
        out = []
        for ip in addresses:
            family = 10 if ":" in ip else 2
            out.append((family, 1, 6, "", (ip, 0)))
        return out

    monkeypatch.setattr(fetcher.socket, "getaddrinfo", getaddrinfo)


class TestPinning:
    async def test_connects_to_validated_ip_and_keeps_host_and_sni(self, monkeypatch):
        fake_dns(monkeypatch, {"shop.example": ["93.184.216.34"]})
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["host"] = request.headers.get("host")
            seen["sni"] = request.extensions.get("sni_hostname")
            return httpx.Response(200, headers=HTML, text="<html><title>ok</title></html>")

        html = await fetcher.fetch_html(
            "https://shop.example/p/1?a=b", transport=httpx.MockTransport(handler)
        )
        assert "ok" in html
        # Адреса зʼєднання — IP; шлях і запит збережено.
        assert seen["url"] == "https://93.184.216.34/p/1?a=b"
        # Магазин має впізнати себе: інакше віддасть не ту сторінку або не той сертифікат.
        assert seen["host"] == "shop.example"
        assert seen["sni"] == "shop.example"

    async def test_port_is_kept_in_url_and_host(self, monkeypatch):
        fake_dns(monkeypatch, {"shop.example": ["93.184.216.34"]})
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["host"] = request.headers.get("host")
            return httpx.Response(200, headers=HTML, text="<html></html>")

        await fetcher.fetch_html(
            "http://shop.example:8080/p", transport=httpx.MockTransport(handler)
        )
        assert seen["url"] == "http://93.184.216.34:8080/p"
        assert seen["host"] == "shop.example:8080"

    async def test_ipv6_address_is_bracketed(self, monkeypatch):
        fake_dns(monkeypatch, {"shop.example": ["2606:2800:220:1:248:1893:25c8:1946"]})
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            return httpx.Response(200, headers=HTML, text="<html></html>")

        await fetcher.fetch_html("https://shop.example/p", transport=httpx.MockTransport(handler))
        assert seen["url"] == "https://[2606:2800:220:1:248:1893:25c8:1946]/p"


class TestAddressOrder:
    def test_ipv4_comes_first(self, monkeypatch):
        # Cloud Run не має вихідного IPv6: почавши з нього, ми втратили б
        # усі дуально стекові магазини.
        fake_dns(monkeypatch, {"shop.example": ["2606:2800::1", "93.184.216.34"]})
        targets, hostname, host_header = fetcher._pinned_targets("https://shop.example/p")
        assert targets == ["https://93.184.216.34/p", "https://[2606:2800::1]/p"]
        assert (hostname, host_header) == ("shop.example", "shop.example")


class TestFailover:
    async def test_second_address_is_used_when_first_refuses(self, monkeypatch):
        fake_dns(monkeypatch, {"shop.example": ["93.184.216.34", "93.184.216.35"]})
        tried: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            tried.append(request.url.host)
            if request.url.host == "93.184.216.34":
                raise httpx.ConnectError("refused", request=request)
            return httpx.Response(200, headers=HTML, text="<html><title>друга</title></html>")

        html = await fetcher.fetch_html(
            "https://shop.example/p", transport=httpx.MockTransport(handler)
        )
        assert "друга" in html
        assert tried == ["93.184.216.34", "93.184.216.35"]

    async def test_all_addresses_down_gives_upstream_error(self, monkeypatch):
        fake_dns(monkeypatch, {"shop.example": ["93.184.216.34", "93.184.216.35"]})

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        with pytest.raises(HTTPException) as exc:
            await fetcher.fetch_html(
                "https://shop.example/p", transport=httpx.MockTransport(handler)
            )
        assert (exc.value.status_code, exc.value.detail) == (502, "upstream_error")


class TestRedirects:
    async def test_redirect_to_private_address_is_blocked(self, monkeypatch):
        # Класичний обхід: публічний домен → 302 → метадані хмари.
        fake_dns(monkeypatch, {"shop.example": ["93.184.216.34"], "metadata.evil": ["169.254.169.254"]})

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(302, headers={"location": "http://metadata.evil/computeMetadata/v1/"})

        with pytest.raises(HTTPException) as exc:
            await fetcher.fetch_html(
                "https://shop.example/p", transport=httpx.MockTransport(handler)
            )
        assert (exc.value.status_code, exc.value.detail) == (403, "blocked_host")

    async def test_relative_redirect_resolves_against_real_host_not_ip(self, monkeypatch):
        fake_dns(monkeypatch, {"shop.example": ["93.184.216.34"]})
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            if request.url.path == "/p":
                return httpx.Response(302, headers={"location": "/final"})
            return httpx.Response(200, headers=HTML, text="<html><title>final</title></html>")

        html = await fetcher.fetch_html(
            "https://shop.example/p", transport=httpx.MockTransport(handler)
        )
        assert "final" in html
        # Обидва переходи пінуються на ту саму перевірену адресу.
        assert seen == ["https://93.184.216.34/p", "https://93.184.216.34/final"]

    async def test_redirect_loop_stops(self, monkeypatch):
        fake_dns(monkeypatch, {"shop.example": ["93.184.216.34"]})

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(302, headers={"location": "/next"})

        with pytest.raises(HTTPException) as exc:
            await fetcher.fetch_html(
                "https://shop.example/p", transport=httpx.MockTransport(handler)
            )
        assert (exc.value.status_code, exc.value.detail) == (502, "too_many_redirects")


class TestRebinding:
    async def test_second_resolution_cannot_change_target(self, monkeypatch):
        """
        DNS віддає публічну адресу першим запитом і приватну — наступним.
        З піном друга відповідь ні на що не впливає: зʼєднання вже йде на
        перевірену IP. Без піна саме тут сервіс пішов би на 169.254.169.254.
        """
        answers = iter([["93.184.216.34"], ["169.254.169.254"], ["169.254.169.254"]])
        current = {"ips": next(answers)}

        def getaddrinfo(host, *_args, **_kwargs):
            ips = current["ips"]
            current["ips"] = next(answers, ips)
            return [(2, 1, 6, "", (ip, 0)) for ip in ips]

        monkeypatch.setattr(fetcher.socket, "getaddrinfo", getaddrinfo)
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.host)
            return httpx.Response(200, headers=HTML, text="<html><title>ok</title></html>")

        await fetcher.fetch_html("https://shop.example/p", transport=httpx.MockTransport(handler))
        assert seen == ["93.184.216.34"]

"""
Найважливіші тести сервісу. Парсер ходить за довільними URL,
тож без цих перевірок він стає інструментом доступу до внутрішньої мережі —
зокрема до метаданих GCP на 169.254.169.254.
"""

import pytest

from app.fetcher import BlockedHost, assert_public_url


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/admin",
        "http://localhost:8080/",
        "http://169.254.169.254/computeMetadata/v1/",   # метадані хмари
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://172.16.0.9/",
        "http://[::1]/",
        "http://0.0.0.0/",
        "http://100.64.1.1/",          # CGNAT: там живуть VPC-конектори хмар
        "http://224.0.0.1/",           # multicast
        "http://239.255.255.250/",     # SSDP
        "http://[ff02::1]/",
    ],
)
def test_private_targets_blocked(url):
    with pytest.raises(BlockedHost):
        assert_public_url(url)


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com/", "gopher://x/"])
def test_non_http_schemes_blocked(url):
    with pytest.raises(BlockedHost):
        assert_public_url(url)


def test_unresolvable_host_blocked():
    with pytest.raises(BlockedHost):
        assert_public_url("http://nonexistent.invalid/")


def test_public_host_allowed(monkeypatch):
    # Test the actual URL/DNS validation without depending on public DNS or a
    # runner's proxy. Rebinding/transport behavior has separate pinning tests.
    import socket

    def resolve(host, *_args, **_kwargs):
        assert host == "example.com"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    assert_public_url("https://example.com/")

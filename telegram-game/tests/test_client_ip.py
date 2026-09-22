"""Forwarded client IPs are accepted only from a configured trusted proxy."""

from types import SimpleNamespace

import pytest
from starlette.requests import Request

from zyron_node.api import client_ip
from zyron_node.client_ip import client_address, parse_network_tokens
from zyron_node.config import ConfigError, load_settings

PRIVATE = parse_network_tokens(["10.0.0.0/8"])


def test_untrusted_peer_cannot_spoof_forwarded_for():
    assert (
        client_address(
            "203.0.113.9",
            PRIVATE,
            forwarded_for=["1.2.3.4, 198.51.100.20"],
            forwarded=['for=198.51.100.21'],
            real_ip="198.51.100.22",
        )
        == "203.0.113.9"
    )


def test_non_ip_peer_ignores_spoofed_headers():
    assert client_address("testclient", PRIVATE, forwarded_for=["198.51.100.8"]) == "testclient"
    assert client_address(None, PRIVATE, forwarded_for=["198.51.100.8"]) == "unknown"


def test_empty_trust_list_ignores_forwarded_headers():
    assert client_address("127.0.0.1", (), forwarded_for=["198.51.100.8"]) == "127.0.0.1"


def test_trusted_proxy_uses_forwarded_client():
    assert (
        client_address("10.1.2.3", PRIVATE, forwarded_for=["198.51.100.20, 10.4.5.6"])
        == "198.51.100.20"
    )


def test_trusted_proxy_skips_spoofed_address_left_of_the_client():
    # The proxy appends. The rightmost untrusted hop is the client the proxy saw.
    assert (
        client_address("10.0.0.8", PRIVATE, forwarded_for=["8.8.8.8, 198.51.100.7"])
        == "198.51.100.7"
    )


def test_trusted_proxy_missing_headers_use_peer():
    assert client_address("10.0.0.8", PRIVATE) == "10.0.0.8"
    assert client_address("10.0.0.8", PRIVATE, forwarded_for=["", "   "], real_ip="  ") == "10.0.0.8"


def test_malformed_forwarded_for_falls_back_to_peer():
    assert (
        client_address("10.0.0.8", PRIVATE, forwarded_for=["not-an-ip", "<script>, unknown"])
        == "10.0.0.8"
    )


def test_malformed_tokens_are_skipped_when_a_real_address_remains():
    assert (
        client_address("10.0.0.8", PRIVATE, forwarded_for=["garbage, 198.51.100.9:443, also-bad"])
        == "198.51.100.9"
    )


def test_forwarded_and_real_ip_used_only_when_xff_is_absent():
    proxies = parse_network_tokens(["10.0.0.0/8", "203.0.113.0/24"])
    assert (
        client_address("10.0.0.8", proxies, forwarded=['for="[2001:db8:cafe::17]:4711";proto=https'])
        == "2001:db8:cafe::17"
    )
    assert (
        client_address("10.0.0.8", proxies, forwarded=["for=198.51.100.50, for=203.0.113.5"])
        == "198.51.100.50"
    )
    assert client_address("10.0.0.8", PRIVATE, real_ip="198.51.100.15") == "198.51.100.15"
    assert client_address("10.0.0.8", PRIVATE, real_ip="not-an-ip") == "10.0.0.8"
    assert client_address("10.0.0.8", PRIVATE, forwarded=["proto=https"]) == "10.0.0.8"
    assert client_address("10.0.0.8", PRIVATE, forwarded=["for=unknown"]) == "10.0.0.8"


def test_ipv6_and_mapped_peers():
    nets = parse_network_tokens(["2001:db8:1::/48", "127.0.0.1"])
    assert (
        client_address("2001:db8:1::8", nets, forwarded_for=["2001:db8:2::10"])
        == "2001:db8:2::10"
    )
    assert (
        client_address("::ffff:127.0.0.1", nets, forwarded_for=["::ffff:198.51.100.8"])
        == "198.51.100.8"
    )


def test_chain_of_only_trusted_hops_uses_the_leftmost():
    assert client_address("10.0.0.1", PRIVATE, forwarded_for=["10.0.0.2, 10.0.0.3"]) == "10.0.0.2"


def _request(peer, headers, networks=()):
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "headers": headers,
        "client": None if peer is None else (peer, 50000),
        "server": ("zyron", 80),
        "app": SimpleNamespace(state=SimpleNamespace(settings=SimpleNamespace(trusted_proxies=networks))),
    }
    return Request(scope)


def test_request_helper_rejects_spoof_and_accepts_trusted_chain():
    spoofed = _request(
        "203.0.113.9",
        [
            (b"x-forwarded-for", b"198.51.100.4"),
            (b"x-real-ip", b"198.51.100.5"),
        ],
        PRIVATE,
    )
    assert client_ip(spoofed) == "203.0.113.9"

    trusted = _request(
        "10.0.0.1",
        [
            (b"x-forwarded-for", b"10.0.0.4"),
            (b"x-forwarded-for", b"198.51.100.5"),
        ],
        PRIVATE,
    )
    assert client_ip(trusted) == "198.51.100.5"

    missing = _request("10.0.0.1", [], PRIVATE)
    assert client_ip(missing) == "10.0.0.1"

    malformed = _request("10.0.0.1", [(b"x-forwarded-for", b"nope")], PRIVATE)
    assert client_ip(malformed) == "10.0.0.1"


def test_trust_proxy_boolean_without_a_list_is_rejected(monkeypatch):
    monkeypatch.delenv("TRUSTED_PROXIES", raising=False)
    monkeypatch.setenv("TRUST_PROXY", "1")
    with pytest.raises(ConfigError, match="trust every peer"):
        load_settings()
    monkeypatch.setenv("TRUST_PROXY", "true")
    with pytest.raises(ConfigError, match="trust every peer"):
        load_settings()


def test_trusted_proxy_lists_parse_and_union(monkeypatch):
    monkeypatch.setenv("TRUST_PROXY", "0")
    monkeypatch.setenv("TRUSTED_PROXIES", "127.0.0.1, 10.0.0.0/8")
    settings = load_settings()
    assert client_address("127.0.0.1", settings.trusted_proxies, forwarded_for=["198.51.100.2"]) == "198.51.100.2"
    assert client_address("11.0.0.1", settings.trusted_proxies, forwarded_for=["198.51.100.2"]) == "11.0.0.1"

    monkeypatch.setenv("TRUST_PROXY", "192.0.2.10")
    monkeypatch.setenv("TRUSTED_PROXIES", "10.0.0.0/8")
    settings = load_settings()
    assert client_address("192.0.2.10", settings.trusted_proxies, forwarded_for=["198.51.100.3"]) == "198.51.100.3"

    monkeypatch.setenv("TRUST_PROXY", "yes")
    monkeypatch.setenv("TRUSTED_PROXIES", "172.16.0.0/12")
    settings = load_settings()
    assert client_address("172.16.1.1", settings.trusted_proxies, forwarded_for=["198.51.100.4"]) == "198.51.100.4"


def test_invalid_proxy_cidr_is_rejected(monkeypatch):
    monkeypatch.setenv("TRUST_PROXY", "")
    monkeypatch.setenv("TRUSTED_PROXIES", "10.0.0.0/99")
    with pytest.raises(ConfigError, match="not an IP address or CIDR"):
        load_settings()


def test_disabled_proxy_settings_leave_an_empty_list(monkeypatch):
    monkeypatch.setenv("TRUST_PROXY", "none")
    monkeypatch.setenv("TRUSTED_PROXIES", "")
    assert load_settings().trusted_proxies == ()

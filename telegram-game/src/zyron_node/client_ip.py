"""Client address for rate limits and signup-network hashes.

Forwarded headers are honored only when the TCP peer is inside an explicit
trusted-proxy list. Every other connection uses the socket address, so a
client cannot choose its own network hash by sending ``X-Forwarded-For``.
"""

from __future__ import annotations

import ipaddress
from collections.abc import Iterable, Sequence

Network = ipaddress.IPv4Network | ipaddress.IPv6Network
Address = ipaddress.IPv4Address | ipaddress.IPv6Address

_MAX_LEN = 64
_OBSCURED = {"unknown", "hidden", "_hidden"}


def parse_network_tokens(tokens: Iterable[str]) -> tuple[Network, ...]:
    """Parse IP and CIDR tokens. A bare address becomes a /32 or /128."""
    networks: list[Network] = []
    for token in tokens:
        try:
            network = ipaddress.ip_network(token, strict=False)
        except ValueError as exc:
            raise ValueError(f"{token!r} is not an IP address or CIDR") from exc
        if network not in networks:
            networks.append(network)
    return tuple(networks)


def client_address(
    peer: str | None,
    trusted_networks: Sequence[Network],
    *,
    forwarded_for: Sequence[str] = (),
    forwarded: Sequence[str] = (),
    real_ip: str | None = None,
) -> str:
    """Return the client IP to record.

    ``peer`` is the TCP remote address. When it is missing, not an IP, or
    outside ``trusted_networks``, forwarded headers are ignored.

    A trusted peer may supply ``X-Forwarded-For``, then RFC 7239 ``Forwarded``,
    then ``X-Real-IP``. The address is the rightmost hop that is not itself a
    trusted proxy. Invalid tokens are skipped. If a present header contains no
    usable address, the result is the TCP peer.
    """
    if not _peer_is_trusted(peer, trusted_networks):
        return _peer_result(peer)

    peer_ip = _normalize(_parse_ip(peer or ""))
    if _present(forwarded_for):
        return _from_chain(_addresses(forwarded_for), peer_ip, trusted_networks, peer)
    if _present(forwarded):
        return _from_chain(_forwarded_addresses(forwarded), peer_ip, trusted_networks, peer)
    if real_ip and real_ip.strip():
        parsed = _parse_ip(real_ip)
        if parsed is None:
            return _peer_result(peer)
        return _from_chain([_normalize(parsed)], peer_ip, trusted_networks, peer)
    return _peer_result(peer)


def _peer_is_trusted(peer: str | None, trusted_networks: Sequence[Network]) -> bool:
    if not peer or not trusted_networks:
        return False
    parsed = _parse_ip(peer)
    if parsed is None:
        return False
    return _is_trusted(_normalize(parsed), trusted_networks)


def _from_chain(
    forwarded_ips: Sequence[Address],
    peer_ip: Address | None,
    trusted_networks: Sequence[Network],
    peer: str | None,
) -> str:
    if not forwarded_ips:
        return _peer_result(peer)
    chain = list(forwarded_ips)
    if peer_ip is not None:
        chain.append(peer_ip)
    for hop in reversed(chain):
        if not _is_trusted(hop, trusted_networks):
            return str(hop)[:_MAX_LEN]
    return str(chain[0])[:_MAX_LEN]


def _peer_result(peer: str | None) -> str:
    if not peer or not peer.strip():
        return "unknown"
    return peer.strip()[:_MAX_LEN]


def _present(values: Sequence[str]) -> bool:
    return any(value.strip() for value in values)


def _is_trusted(ip: Address, networks: Sequence[Network]) -> bool:
    return any(ip in network for network in networks)


def _normalize(ip: Address | None) -> Address | None:
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped
        if mapped is not None:
            return mapped
    return ip


def _addresses(values: Sequence[str]) -> list[Address]:
    found: list[Address] = []
    for value in values:
        for part in value.split(","):
            parsed = _parse_ip(part)
            if parsed is not None:
                normalized = _normalize(parsed)
                if normalized is not None:
                    found.append(normalized)
    return found


def _forwarded_addresses(headers: Sequence[str]) -> list[Address]:
    nodes: list[str] = []
    for header in headers:
        for element in _split_outside_quotes(header, ","):
            node = _forwarded_for_param(element)
            if node is not None:
                nodes.append(node)
    return _addresses(nodes)


def _forwarded_for_param(element: str) -> str | None:
    for param in _split_outside_quotes(element, ";"):
        if "=" not in param:
            continue
        name, value = param.split("=", 1)
        if name.strip().lower() != "for":
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = value[1:-1]
        return value.strip()
    return None


def _split_outside_quotes(value: str, separator: str) -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    quoted = False
    for char in value:
        if char == '"':
            quoted = not quoted
            buf.append(char)
        elif char == separator and not quoted:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(char)
    if buf:
        parts.append("".join(buf))
    return parts


def _parse_ip(token: str) -> Address | None:
    host = _strip_decoration(token)
    if host is None:
        return None
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def _strip_decoration(token: str) -> str | None:
    token = token.strip()
    if len(token) >= 2 and token[0] == '"' and token[-1] == '"':
        token = token[1:-1].strip()
    if not token or token.lower() in _OBSCURED:
        return None
    if token.startswith("["):
        end = token.find("]")
        if end <= 1:
            return None
        return token[1:end]
    if token.count(":") == 1:
        host, _, port = token.partition(":")
        if host and port.isdigit():
            return host
    return token

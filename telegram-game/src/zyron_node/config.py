"""Process configuration. Secrets come from the environment, never from the repo."""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse

from zyron_node.client_ip import Network, parse_network_tokens


class ConfigError(RuntimeError):
    pass


def _bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer") from exc


@dataclass(frozen=True)
class Settings:
    environment: str
    database_url: str
    redis_url: str | None
    telegram_bot_token: str
    telegram_bot_username: str
    webapp_url: str
    admin_token: str
    init_data_max_age_seconds: int
    dev_auth_bypass: bool
    allow_test_clock: bool
    zyron_rpc_url: str
    zyron_rpc_allow_remote: bool
    referral_ip_salt: str
    referral_min_age_seconds: int
    referral_min_cycles: int
    trusted_proxies: tuple[Network, ...]
    log_level: str
    host: str
    port: int
    cycle_min_interval_ms: int

    def redacted(self) -> dict[str, object]:
        return {
            "environment": self.environment,
            "databaseHost": _db_host(self.database_url),
            "redis": bool(self.redis_url),
            "botConfigured": bool(self.telegram_bot_token),
            "webappUrl": self.webapp_url,
            "devAuthBypass": self.dev_auth_bypass,
            "rpcConfigured": bool(self.zyron_rpc_url),
            "rpcAllowRemote": self.zyron_rpc_allow_remote,
            "trustedProxies": len(self.trusted_proxies),
            "host": self.host,
            "port": self.port,
        }


def load_settings() -> Settings:
    redis = os.environ.get("REDIS_URL", "").strip()
    return Settings(
        environment=os.environ.get("ENVIRONMENT", "development").strip() or "development",
        database_url=os.environ.get("DATABASE_URL", "").strip(),
        redis_url=redis or None,
        telegram_bot_token=os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(),
        telegram_bot_username=os.environ.get("TELEGRAM_BOT_USERNAME", "").strip().lstrip("@"),
        webapp_url=os.environ.get("WEBAPP_URL", "").strip(),
        admin_token=os.environ.get("ADMIN_TOKEN", "").strip(),
        init_data_max_age_seconds=_int("INIT_DATA_MAX_AGE_SECONDS", 43_200),
        dev_auth_bypass=_bool("DEV_AUTH_BYPASS", False),
        allow_test_clock=_bool("ALLOW_TEST_CLOCK", False),
        zyron_rpc_url=os.environ.get("ZYRON_RPC_URL", "").strip().rstrip("/"),
        zyron_rpc_allow_remote=_bool("ZYRON_RPC_ALLOW_REMOTE", False),
        referral_ip_salt=os.environ.get("REFERRAL_IP_SALT", "dev-salt-change-me"),
        referral_min_age_seconds=_int("REFERRAL_MIN_AGE_SECONDS", 1800),
        referral_min_cycles=_int("REFERRAL_MIN_CYCLES", 15),
        trusted_proxies=_trusted_proxies(),
        log_level=os.environ.get("LOG_LEVEL", "INFO").strip().upper() or "INFO",
        host=os.environ.get("HOST", "0.0.0.0").strip() or "0.0.0.0",
        port=_int("PORT", 8000),
        cycle_min_interval_ms=_int("CYCLE_MIN_INTERVAL_MS", 800),
    )


def validate_settings(settings: Settings) -> None:
    if not settings.database_url:
        raise ConfigError("DATABASE_URL is required")
    if settings.init_data_max_age_seconds < 30 or settings.init_data_max_age_seconds > 86_400:
        raise ConfigError("INIT_DATA_MAX_AGE_SECONDS must be between 30 and 86400")
    if settings.cycle_min_interval_ms < 200 or settings.cycle_min_interval_ms > 60_000:
        raise ConfigError("CYCLE_MIN_INTERVAL_MS is out of range")
    if settings.referral_min_cycles < 1:
        raise ConfigError("REFERRAL_MIN_CYCLES must be at least 1")
    if settings.port < 1 or settings.port > 65535:
        raise ConfigError("PORT is invalid")
    if settings.zyron_rpc_url:
        validate_rpc_base(settings.zyron_rpc_url, settings.zyron_rpc_allow_remote)
    if settings.environment == "production":
        if settings.dev_auth_bypass or settings.allow_test_clock:
            raise ConfigError("DEV_AUTH_BYPASS and ALLOW_TEST_CLOCK must be off in production")
        if len(settings.admin_token) < 24:
            raise ConfigError("ADMIN_TOKEN must be at least 24 characters in production")
        if not settings.telegram_bot_token:
            raise ConfigError("TELEGRAM_BOT_TOKEN is required in production")
        if not settings.webapp_url.startswith("https://"):
            raise ConfigError("WEBAPP_URL must be https in production")
        if settings.referral_ip_salt in {"", "dev-salt-change-me"} or len(settings.referral_ip_salt) < 16:
            raise ConfigError("REFERRAL_IP_SALT must be a non-default value of at least 16 characters")
    if settings.allow_test_clock and settings.environment != "test":
        raise ConfigError("ALLOW_TEST_CLOCK is only valid when ENVIRONMENT=test")


def validate_rpc_base(url: str, allow_remote: bool) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ConfigError("ZYRON_RPC_URL must be an http(s) URL")
    if parsed.username or parsed.password:
        raise ConfigError("ZYRON_RPC_URL must not embed credentials")
    host = parsed.hostname.lower().strip("[]")
    if host in {"169.254.169.254", "metadata.google.internal", "0.0.0.0"}:
        raise ConfigError("ZYRON_RPC_URL host is blocked")
    loopback = host in {"localhost", "127.0.0.1", "::1"}
    if not loopback:
        if not allow_remote:
            raise ConfigError(
                "Remote ZYRON_RPC_URL is disabled. Set ZYRON_RPC_ALLOW_REMOTE=1 only for an operator-controlled read-only node"
            )
        if parsed.scheme != "https":
            raise ConfigError("Non-loopback Zyron RPC must use HTTPS")


_PROXY_TRUTHY = {"1", "true", "yes", "on"}
_PROXY_FALSEY = {"", "0", "false", "no", "off", "none"}


def _trusted_proxies() -> tuple[Network, ...]:
    """Load the reverse proxies allowed to supply a client address.

    ``TRUST_PROXY=1`` (or true/yes/on) used to mean "trust every peer". That
    accepts a spoofed ``X-Forwarded-For`` from the client itself, so a boolean
    with no explicit list is rejected. ``TRUSTED_PROXIES`` and a list in
    ``TRUST_PROXY`` are comma- or whitespace-separated IPs and CIDRs. When the
    boolean form is set together with ``TRUSTED_PROXIES``, the list is used.
    """
    trust_raw = os.environ.get("TRUST_PROXY", "").strip()
    list_raw = os.environ.get("TRUSTED_PROXIES", "").strip()
    tokens: list[str] = []
    if trust_raw.lower() in _PROXY_TRUTHY:
        if list_raw.lower() in _PROXY_FALSEY:
            raise ConfigError(
                "TRUST_PROXY=1 would trust every peer. "
                "Set TRUSTED_PROXIES or TRUST_PROXY to a list of proxy IPs or CIDRs"
            )
    elif trust_raw.lower() not in _PROXY_FALSEY:
        tokens.extend(_proxy_tokens(trust_raw))
    if list_raw.lower() not in _PROXY_FALSEY:
        tokens.extend(_proxy_tokens(list_raw))
    try:
        return parse_network_tokens(tokens)
    except ValueError as exc:
        raise ConfigError(str(exc)) from exc


def _proxy_tokens(raw: str) -> list[str]:
    tokens: list[str] = []
    for chunk in raw.replace(";", ",").split(","):
        tokens.extend(part for part in chunk.split() if part)
    return tokens


def _db_host(database_url: str) -> str:
    if not database_url:
        return ""
    try:
        return urlparse(database_url).hostname or ""
    except ValueError:
        return ""

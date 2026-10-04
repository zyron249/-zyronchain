"""Minimal Telegram Bot API client that keeps the status details reminders need (403, 429 retry_after)."""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger("zyron_node.telegram")


class TelegramError(RuntimeError):
    def __init__(self, method: str, status: int, description: str = "", retry_after: int | None = None):
        super().__init__(f"telegram {method} failed ({status})")
        self.method = method
        self.status = status
        self.description = description
        self.retry_after = retry_after

    @property
    def unreachable(self) -> bool:
        """The chat can no longer receive messages: bot blocked, user deactivated, or chat gone."""
        if self.status == 403:
            return True
        text = self.description.lower()
        return self.status == 400 and ("chat not found" in text or "user is deactivated" in text)


def call(token: str, method: str, payload: dict, timeout: float = 15) -> dict:
    response = httpx.post(f"https://api.telegram.org/bot{token}/{method}", json=payload, timeout=timeout)
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code >= 400 or not body.get("ok"):
        params = body.get("parameters") or {}
        retry_after = params.get("retry_after")
        log.warning("telegram %s http %s", method, response.status_code)
        raise TelegramError(
            method,
            response.status_code,
            str(body.get("description") or ""),
            int(retry_after) if isinstance(retry_after, int) else None,
        )
    return body

"""Fixed-window rate limits stored in PostgreSQL so they share the game's durability."""

from __future__ import annotations

from datetime import datetime, timezone


class RateLimitExceeded(Exception):
    def __init__(self, retry_after: int):
        self.retry_after = max(1, int(retry_after))
        super().__init__("rate limit exceeded")


def consume_rate(conn, key: str, limit: int, window_seconds: int, now: datetime) -> None:
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    epoch = int(now.timestamp())
    start_epoch = epoch - (epoch % window_seconds)
    window_start = datetime.fromtimestamp(start_epoch, tz=timezone.utc)
    row = conn.execute(
        """
        INSERT INTO rate_limits (bucket_key, window_start, hits)
        VALUES (%s, %s, 1)
        ON CONFLICT (bucket_key, window_start)
        DO UPDATE SET hits = rate_limits.hits + 1
        RETURNING hits
        """,
        (key, window_start),
    ).fetchone()
    if int(row["hits"]) > limit:
        raise RateLimitExceeded(window_seconds - (epoch - start_epoch))
    if int(row["hits"]) == 1 and epoch % 17 == 0:
        cutoff = datetime.fromtimestamp(epoch - 86_400, tz=timezone.utc)
        conn.execute("DELETE FROM rate_limits WHERE window_start < %s", (cutoff,))


def hit(pool, key: str, limit: int, window_seconds: int, now: datetime) -> None:
    with pool.connection() as conn:
        with conn.transaction():
            consume_rate(conn, key, limit, window_seconds, now)

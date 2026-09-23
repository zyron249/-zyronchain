"""PostgreSQL pool and ordered SQL migrations."""

from __future__ import annotations

import time
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"
OPENING_LEDGER_MIGRATION = "003_activity_ledger.sql"


def create_pool(database_url: str) -> ConnectionPool:
    return ConnectionPool(
        database_url,
        min_size=1,
        max_size=10,
        timeout=10,
        kwargs={
            "row_factory": dict_row,
            "options": "-c statement_timeout=8000 -c timezone=UTC",
        },
        open=True,
    )


def wait_for_database(database_url: str, attempts: int = 30) -> None:
    last: Exception | None = None
    for _ in range(attempts):
        try:
            with create_pool(database_url) as pool:
                with pool.connection() as conn:
                    conn.execute("SELECT 1")
            return
        except Exception as exc:  # noqa: BLE001 — startup retry
            last = exc
            time.sleep(1)
    raise RuntimeError("database did not become ready") from last


def apply_migrations(conn) -> list[str]:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    applied = {row["version"] for row in conn.execute("SELECT version FROM schema_migrations").fetchall()}
    fresh: list[str] = []
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if path.name in applied:
            continue
        for statement in split_sql(path.read_text(encoding="utf-8")):
            conn.execute(statement)
        if path.name == OPENING_LEDGER_MIGRATION:
            # Same transaction as the schema version insert. Existing lifetime
            # totals are seeded once; later startups do not run this again.
            from zyron_node.ledger import seed_opening_ledger

            seed_opening_ledger(conn)
        conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (path.name,))
        fresh.append(path.name)
    return fresh


def migrate(pool: ConnectionPool) -> list[str]:
    with pool.connection() as conn:
        with conn.transaction():
            return apply_migrations(conn)


def split_sql(sql: str) -> list[str]:
    """Split a migration on semicolons that are outside comments and dollar quotes.

    String literals in these files do not contain semicolons. Dollar-quoted
    function bodies may.
    """
    statements: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(sql)
    dollar: str | None = None
    while i < n:
        if dollar is not None:
            if sql.startswith(dollar, i):
                buf.append(dollar)
                i += len(dollar)
                dollar = None
                continue
            buf.append(sql[i])
            i += 1
            continue
        if sql.startswith("--", i):
            end = sql.find("\n", i)
            i = n if end < 0 else end + 1
            continue
        if sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            if end < 0:
                raise ValueError("unterminated block comment in migration")
            i = end + 2
            continue
        if sql[i] == "$":
            tag = _dollar_tag(sql, i)
            if tag is not None:
                buf.append(tag)
                i += len(tag)
                dollar = tag
                continue
        if sql[i] == ";":
            statement = "".join(buf).strip()
            buf = []
            if statement:
                statements.append(statement)
            i += 1
            continue
        buf.append(sql[i])
        i += 1
    trailing = "".join(buf).strip()
    if trailing:
        statements.append(trailing)
    return statements


def _dollar_tag(sql: str, start: int) -> str | None:
    if sql[start] != "$":
        return None
    j = start + 1
    while j < len(sql) and (sql[j].isalnum() or sql[j] == "_"):
        j += 1
    if j < len(sql) and sql[j] == "$":
        return sql[start : j + 1]
    return None

"""PostgreSQL pool and ordered SQL migrations."""

from __future__ import annotations

import time
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


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
        conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (path.name,))
        fresh.append(path.name)
    return fresh


def migrate(pool: ConnectionPool) -> list[str]:
    with pool.connection() as conn:
        with conn.transaction():
            return apply_migrations(conn)


def split_sql(sql: str) -> list[str]:
    """Split a migration file on semicolons. Statements do not contain semicolons in literals."""
    statements: list[str] = []
    buffer: list[str] = []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--"):
            continue
        buffer.append(line)
        if stripped.endswith(";"):
            statement = "\n".join(buffer).strip()
            buffer = []
            if statement.endswith(";"):
                statement = statement[:-1].strip()
            if statement:
                statements.append(statement)
    trailing = "\n".join(buffer).strip()
    if trailing:
        statements.append(trailing.rstrip(";").strip())
    return statements

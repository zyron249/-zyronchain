import json
import os
import psycopg2


class BlockchainStorage:
    def __init__(self):
        self.database_url = os.environ.get("DATABASE_URL")

    def get_connection(self):
        return psycopg2.connect(self.database_url)

    def setup_database(self):
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS blockchain_blocks (
                        block_index INTEGER PRIMARY KEY,
                        block_data JSONB NOT NULL
                    );
                """)

                cur.execute("""
                    CREATE TABLE IF NOT EXISTS blockchain_peers (
                        node_url TEXT PRIMARY KEY
                    );
                """)

                cur.execute("""
                    CREATE TABLE IF NOT EXISTS faucet_claims (
                        address TEXT PRIMARY KEY,
                        last_claim DOUBLE PRECISION NOT NULL
                    );
                """)

                cur.execute("""
                    CREATE TABLE IF NOT EXISTS blockchain_peer_reputation (
                        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
                        state_data JSONB NOT NULL
                    );
                """)

                cur.execute("""
                    CREATE TABLE IF NOT EXISTS blockchain_schema_version (
                        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
                        version INTEGER NOT NULL
                    );
                """)

                cur.execute("""
                    INSERT INTO blockchain_schema_version (singleton, version)
                    VALUES (TRUE, 2)
                    ON CONFLICT (singleton)
                    DO UPDATE SET version = GREATEST(blockchain_schema_version.version, EXCLUDED.version);
                """)

                conn.commit()

    def save_chain(self, chain_data):
        if not self.database_url:
            return

        self.setup_database()

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT block_index, block_data->>'hash'
                    FROM blockchain_blocks
                    ORDER BY block_index ASC;
                """)
                existing = cur.fetchall()

                common_prefix = 0
                for block_index, stored_hash in existing:
                    if block_index >= len(chain_data):
                        break
                    incoming = chain_data[block_index]
                    if block_index != incoming.get("index") or stored_hash != incoming.get("hash"):
                        break
                    common_prefix += 1

                if common_prefix < len(existing):
                    cur.execute(
                        "DELETE FROM blockchain_blocks WHERE block_index >= %s;",
                        (common_prefix,)
                    )

                for block in chain_data[common_prefix:]:
                    cur.execute(
                        """
                        INSERT INTO blockchain_blocks (block_index, block_data)
                        VALUES (%s, %s)
                        ON CONFLICT (block_index)
                        DO UPDATE SET block_data = EXCLUDED.block_data;
                        """,
                        (block["index"], json.dumps(block))
                    )

                conn.commit()

    def load_chain(self):
        if not self.database_url:
            return None

        self.setup_database()

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT block_data
                    FROM blockchain_blocks
                    ORDER BY block_index ASC;
                """)

                rows = cur.fetchall()

        if not rows:
            return None

        return [row[0] for row in rows]

    def save_peer(self, node_url):
        if not self.database_url:
            return

        self.setup_database()

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO blockchain_peers (node_url)
                    VALUES (%s)
                    ON CONFLICT (node_url) DO NOTHING;
                    """,
                    (node_url,)
                )

                conn.commit()

    def load_peers(self):
        if not self.database_url:
            return []

        self.setup_database()

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT node_url
                    FROM blockchain_peers
                    ORDER BY node_url ASC;
                """)

                rows = cur.fetchall()

        return [row[0] for row in rows]

    def peer_exists(self, node_url):
        if not self.database_url:
            return False

        self.setup_database()

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT 1
                    FROM blockchain_peers
                    WHERE node_url = %s;
                    """,
                    (node_url,)
                )

                row = cur.fetchone()

        return row is not None

    def remove_peer(self, node_url):
        if not self.database_url:
            return

        self.setup_database()

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM blockchain_peers
                    WHERE node_url = %s;
                    """,
                    (node_url,)
                )

                conn.commit()

    def save_faucet_claim(self, address, timestamp):
        if not self.database_url:
            return

        self.setup_database()

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO faucet_claims (address, last_claim)
                    VALUES (%s, %s)
                    ON CONFLICT (address)
                    DO UPDATE SET last_claim = EXCLUDED.last_claim;
                    """,
                    (address, timestamp)
                )

                conn.commit()

    def get_last_faucet_claim(self, address):
        if not self.database_url:
            return None

        self.setup_database()

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT last_claim
                    FROM faucet_claims
                    WHERE address = %s;
                    """,
                    (address,)
                )

                row = cur.fetchone()

        if not row:
            return None

        return row[0]

    def save_peer_reputation(self, state):
        if not self.database_url:
            return

        self.setup_database()
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO blockchain_peer_reputation (singleton, state_data)
                    VALUES (TRUE, %s)
                    ON CONFLICT (singleton)
                    DO UPDATE SET state_data = EXCLUDED.state_data;
                    """,
                    (json.dumps(state),)
                )
                conn.commit()

    def load_peer_reputation(self):
        if not self.database_url:
            return None

        self.setup_database()
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT state_data
                    FROM blockchain_peer_reputation
                    WHERE singleton = TRUE;
                """)
                row = cur.fetchone()

        return row[0] if row else None

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

                conn.commit()

    def save_chain(self, chain_data):
        if not self.database_url:
            return

        self.setup_database()

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM blockchain_blocks;")

                for block in chain_data:
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

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

"""ZC-CRY-20260930-004: initData hash must be validated as lowercase hex before HMAC compare.

hmac.compare_digest raises TypeError for non-ASCII str operands. A crafted
64-character non-ASCII ``hash`` therefore escaped AuthError handling (HTTP 500)
and skipped the per-IP auth-failure limiter in api.authorize().
"""

from datetime import datetime, timezone
from urllib.parse import quote

import pytest

from zyron_node.auth import AuthError, verify_init_data

BOT = "123456:TEST_TOKEN_NOT_A_SECRET"
NOW = datetime(2026, 9, 30, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "bad_hash",
    [
        "é" * 64,  # non-ASCII, previously TypeError
        "A" * 64,  # uppercase hex is not what Telegram emits
        "g" * 64,  # non-hex ASCII
        "0" * 63 + "\u0661",  # Arabic-Indic digit, isdigit()-true but not hex
    ],
)
def test_malformed_hash_is_auth_error_not_crash(bad_hash):
    payload = f"auth_date={int(NOW.timestamp())}&user=%7B%22id%22%3A1%7D&hash={quote(bad_hash)}"
    with pytest.raises(AuthError) as info:
        verify_init_data(payload, BOT, NOW, 3600)
    assert info.value.code in {"bad_init_data", "bad_hash"}

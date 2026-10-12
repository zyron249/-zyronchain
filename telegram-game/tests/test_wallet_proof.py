"""Signed wallet link (testnet): challenge, verification, replay, expiry, uniqueness, reward and limits."""

import hashlib
import secrets
from datetime import timedelta

from tests.test_api import NOW, auth
from zyron_node import wallet_proof as wp

# Fixed cross-implementation vector: produced by website/app (zyron-wallet-core.js signLinkProof) for the public
# BIP-39 test phrase "abandon ... about" (m/44'/249249'/0'/0/0). Same vector is asserted in tools/pwa-wallet/test-core.mjs.
VECTOR_MESSAGE = "\n".join([
    "ZYRON NODE wallet link (TESTNET)", "Telegram user: 4242", "Network: zyron-wallet-testnet-1",
    "Nonce: 0123456789abcdef0123456789abcdef", "Issued: 2026-10-12T05:00:00Z", "Expires: 2026-10-12T05:10:00Z",
    "Signing proves you hold this testnet address. It is not a transaction: it moves no funds,",
    "grants no tokens and cannot be used on-chain.",
])
VECTOR_PUBKEY = "06317f0953a96539ad5435839ec3cfbdc8101dab70a9517a887466e882ca69ee5e4b3b52bbdee9fd4aec865685940bb31568887ba73ceaac153aebf77ad62d4c"
VECTOR_SIGNATURE = "5842cdffa0b26d57b399e5ca91432c747e6f335b18f556b0aad19d5826af2e81433265dcfec137121a884b777b4b2b2f43f60673e8a4127b259204a0e7dc5bcb"
VECTOR_ADDRESS = "ZYN16623f437e90cb7216ce70746f642717cc8b531f"


class ThrowawayKey:
    """Throwaway testnet key for tests only (random-k ECDSA, low-S, same format as l1)."""

    def __init__(self):
        self.secret = secrets.randbelow(wp._N - 1) + 1
        x, y = wp._mul(self.secret, wp._G)
        self.public_key = f"{x:064x}{y:064x}"
        self.address = wp.address_from_public_key(self.public_key)

    def sign(self, message_bytes: bytes) -> str:
        e = int.from_bytes(hashlib.sha256(message_bytes).digest(), "big") % wp._N
        while True:
            k = secrets.randbelow(wp._N - 1) + 1
            r = wp._mul(k, wp._G)[0] % wp._N
            s = pow(k, -1, wp._N) * (e + r * self.secret) % wp._N
            if r and s:
                if s > wp._N // 2:
                    s = wp._N - s
                return f"{r:064x}{s:064x}"

    def proof(self, challenge: dict) -> str:
        return f"zyronlink1.{challenge['nonce']}.{self.public_key}.{self.sign(wp.link_signing_bytes(challenge['message']))}"


def challenge(client, user, when=NOW):
    response = client.post("/api/wallet/challenge", headers=auth(user, when))
    assert response.status_code == 200, response.text
    return response.json()


def verify(client, user, proof, when=NOW):
    return client.post("/api/wallet/verify", json={"proof": proof}, headers=auth(user, when))


def test_pwa_vector_verifies_in_python():
    assert wp.address_from_public_key(VECTOR_PUBKEY) == VECTOR_ADDRESS
    assert wp.verify_signature(wp.link_signing_bytes(VECTOR_MESSAGE), VECTOR_SIGNATURE, VECTOR_PUBKEY)
    assert not wp.verify_signature(wp.link_signing_bytes(VECTOR_MESSAGE + " "), VECTOR_SIGNATURE, VECTOR_PUBKEY)
    # High-S twin of a valid signature is rejected (l1 requires low-S).
    r, s = int(VECTOR_SIGNATURE[:64], 16), int(VECTOR_SIGNATURE[64:], 16)
    assert not wp.verify_signature(wp.link_signing_bytes(VECTOR_MESSAGE), f"{r:064x}{wp._N - s:064x}", VECTOR_PUBKEY)
    # Not on the curve.
    assert not wp.verify_signature(wp.link_signing_bytes(VECTOR_MESSAGE), VECTOR_SIGNATURE, "11" * 64)
    assert wp.build_message(4242, "0123456789abcdef0123456789abcdef", NOW.replace(year=2026, month=10, day=12, hour=5, minute=0), NOW.replace(year=2026, month=10, day=12, hour=5, minute=10)) == VECTOR_MESSAGE


def test_challenge_is_testnet_bound_and_verify_links_with_cosmetic_only(client):
    ch = challenge(client, 501)
    assert ch["testnet"] is True and ch["network"] == "zyron-wallet-testnet-1"
    assert "Telegram user: 501" in ch["message"] and f"Nonce: {ch['nonce']}" in ch["message"]
    assert "TESTNET" in ch["message"] and "miner" not in ch["message"].lower()
    before = client.get("/api/me", headers=auth(501)).json()["player"]
    key = ThrowawayKey()
    ok = verify(client, 501, key.proof(ch))
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["address"] == key.address and body["verified"] is True
    assert body["pointsGranted"] == 0 and body["badge"]["id"] == "verified_link" and body["badge"]["new"] is True
    after = client.get("/api/me", headers=auth(501)).json()["player"]
    assert after["walletAddress"] == key.address and after["walletVerified"] is True
    assert "verified_link" in after["cosmetics"]
    assert after["points"] == before["points"] and after["lifetimePoints"] == before["lifetimePoints"]


def test_bad_signature_burns_the_nonce(client):
    ch = challenge(client, 502)
    key, other = ThrowawayKey(), ThrowawayKey()
    forged = f"zyronlink1.{ch['nonce']}.{key.public_key}.{other.sign(wp.link_signing_bytes(ch['message']))}"
    bad = verify(client, 502, forged)
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_signature"
    again = verify(client, 502, key.proof(ch))
    assert again.status_code == 409 and again.json()["error"]["code"] == "challenge_used"
    wrong_text = f"zyronlink1.{ch['nonce']}.{key.public_key}.{key.sign(b'something else')}"
    assert verify(client, 502, wrong_text).status_code in (400, 409)
    malformed = verify(client, 502, "zyronlink1.nothex.zz.zz")
    assert malformed.status_code == 400 and malformed.json()["error"]["code"] == "bad_proof"


def test_expired_nonce_is_rejected(client):
    ch = challenge(client, 503)
    late = verify(client, 503, ThrowawayKey().proof(ch), when=NOW + timedelta(minutes=11))
    assert late.status_code == 410 and late.json()["error"]["code"] == "challenge_expired"


def test_replay_and_cross_account_use_are_rejected(client):
    ch = challenge(client, 504)
    key = ThrowawayKey()
    proof = key.proof(ch)
    assert verify(client, 504, proof).status_code == 200
    replay = verify(client, 504, proof)
    assert replay.status_code == 409 and replay.json()["error"]["code"] == "challenge_used"
    ch2 = challenge(client, 505)
    stolen = verify(client, 506, ThrowawayKey().proof(ch2))
    assert stolen.status_code == 400 and stolen.json()["error"]["code"] == "challenge_unknown"


def test_new_challenge_retires_the_old_one(client):
    first = challenge(client, 507)
    challenge(client, 507)
    old = verify(client, 507, ThrowawayKey().proof(first))
    assert old.status_code == 409


def test_duplicate_address_and_watch_claim_takeover(client):
    key = ThrowawayKey()
    assert verify(client, 510, key.proof(challenge(client, 510))).status_code == 200
    dup = verify(client, 511, key.proof(challenge(client, 511)))
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "address_taken"
    # An unverified watch-only claim yields to the key holder.
    squatted = ThrowawayKey()
    watch = client.post("/api/wallet/link", json={"address": squatted.address, "idempotencyKey": "watch-key-001"}, headers=auth(512))
    assert watch.status_code == 200, watch.text
    taken = verify(client, 513, squatted.proof(challenge(client, 513)))
    assert taken.status_code == 200, taken.text
    assert client.get("/api/me", headers=auth(512)).json()["player"]["walletAddress"] is None
    assert client.get("/api/me", headers=auth(513)).json()["player"]["walletAddress"] == squatted.address
    # A watch-only link cannot grab a verified address.
    grab = client.post("/api/wallet/link", json={"address": squatted.address, "idempotencyKey": "watch-key-002"}, headers=auth(514))
    assert grab.status_code == 409


def test_unlink_relink_rules_and_one_time_badge(client):
    first, second = ThrowawayKey(), ThrowawayKey()
    assert verify(client, 520, first.proof(challenge(client, 520))).status_code == 200
    unlink = client.post("/api/wallet/unlink", json={"idempotencyKey": "unlink-key-01"}, headers=auth(520, NOW + timedelta(minutes=1)))
    assert unlink.status_code == 200
    me = client.get("/api/me", headers=auth(520, NOW + timedelta(minutes=1))).json()["player"]
    assert me["walletAddress"] is None and me["walletVerified"] is False
    assert "verified_link" in me["cosmetics"]  # the badge stays, it is never granted twice
    relink = verify(client, 520, second.proof(challenge(client, 520, NOW + timedelta(minutes=2))), when=NOW + timedelta(minutes=2))
    assert relink.status_code == 200 and relink.json()["badge"]["new"] is False and relink.json()["pointsGranted"] == 0
    # The unlinked address stays reserved to its verified owner.
    other = verify(client, 521, first.proof(challenge(client, 521)))
    assert other.status_code == 409
    # Re-proving the current address is allowed and unchanged.
    same = verify(client, 520, second.proof(challenge(client, 520, NOW + timedelta(minutes=3))), when=NOW + timedelta(minutes=3))
    assert same.status_code == 200 and same.json()["unchanged"] is True
    # Wallet changes are limited per 24 hours (link + unlink + relink + one more change hits the cap).
    third = ThrowawayKey()
    capped = verify(client, 520, third.proof(challenge(client, 520, NOW + timedelta(minutes=4))), when=NOW + timedelta(minutes=4))
    assert capped.status_code == 200
    fourth = ThrowawayKey()
    blocked = verify(client, 520, fourth.proof(challenge(client, 520, NOW + timedelta(minutes=5))), when=NOW + timedelta(minutes=5))
    assert blocked.status_code == 429 and blocked.json()["error"]["code"] == "wallet_limited"


def test_challenge_rate_limit(client):
    for _ in range(10):
        challenge(client, 530)
    limited = client.post("/api/wallet/challenge", headers=auth(530))
    assert limited.status_code == 429

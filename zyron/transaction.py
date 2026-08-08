import hashlib
import json
import math
import time
from decimal import Decimal, InvalidOperation

import ecdsa
from ecdsa.util import sigdecode_string, sigencode_string_canonize


class Transaction:
    LEGACY_VERSION = 1
    V2_VERSION = 2
    CURRENT_VERSION = 3
    CHAIN_ID = "zyron-testnet-1"
    ATOMS_PER_ZYN = 100_000_000
    DEFAULT_FEE_ATOMS = 1_000_000
    MAX_MONEY_ATOMS = 50_000_000 * ATOMS_PER_ZYN

    V3_FIELDS = frozenset({
        "version", "chain_id", "nonce", "sender", "receiver",
        "amount_atoms", "fee_atoms", "timestamp_ms", "public_key",
        "signature", "txid"
    })

    def __init__(
        self,
        sender,
        receiver,
        amount=None,
        public_key=None,
        signature=None,
        timestamp=None,
        txid=None,
        version=CURRENT_VERSION,
        chain_id=CHAIN_ID,
        nonce=0,
        fee=None,
        *,
        amount_atoms=None,
        fee_atoms=None,
        timestamp_ms=None
    ):
        self.version = self._strict_int(version, "version")
        self.chain_id = chain_id
        self.nonce = self._strict_int(nonce, "nonce")
        self.sender = sender
        self.receiver = receiver
        self.public_key = public_key
        self.signature = signature

        if self.version == self.CURRENT_VERSION:
            self.amount_atoms = self._coerce_atoms(amount, amount_atoms, "amount")
            self.fee_atoms = self._coerce_atoms(
                fee,
                fee_atoms,
                "fee",
                default_atoms=self.DEFAULT_FEE_ATOMS
            )
            self.timestamp_ms = self._coerce_timestamp_ms(timestamp, timestamp_ms)
            self.amount = self.amount_atoms / self.ATOMS_PER_ZYN
            self.fee = self.fee_atoms / self.ATOMS_PER_ZYN
            self.timestamp = self.timestamp_ms / 1000
        elif self.version in (self.LEGACY_VERSION, self.V2_VERSION):
            if amount is None:
                raise ValueError("amount is required for legacy transactions")
            self.amount = float(amount)
            self.fee = float(0.01 if fee is None else fee)
            self.timestamp = timestamp if timestamp is not None else time.time()
            self.amount_atoms = None
            self.fee_atoms = None
            self.timestamp_ms = None
        else:
            raise ValueError("Unsupported transaction version")

        self.txid = txid if txid is not None else self.calculate_txid()

    @staticmethod
    def _strict_int(value, field):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{field} must be an integer")
        return value

    @classmethod
    def _tokens_to_atoms(cls, value, field):
        try:
            decimal_value = Decimal(str(value))
        except (InvalidOperation, ValueError, TypeError):
            raise ValueError(f"{field} must be a decimal value")

        if not decimal_value.is_finite():
            raise ValueError(f"{field} must be finite")

        atoms = decimal_value * cls.ATOMS_PER_ZYN
        if atoms != atoms.to_integral_value():
            raise ValueError(f"{field} supports at most 8 decimal places")
        return int(atoms)

    @classmethod
    def _coerce_atoms(cls, token_value, atom_value, field, default_atoms=None):
        if atom_value is not None:
            atoms = cls._strict_int(atom_value, f"{field}_atoms")
            if token_value is not None and cls._tokens_to_atoms(token_value, field) != atoms:
                raise ValueError(f"Conflicting {field} and {field}_atoms")
            return atoms

        if token_value is None:
            if default_atoms is None:
                raise ValueError(f"{field}_atoms is required")
            return default_atoms

        return cls._tokens_to_atoms(token_value, field)

    @staticmethod
    def _coerce_timestamp_ms(timestamp, timestamp_ms):
        if timestamp_ms is not None:
            result = Transaction._strict_int(timestamp_ms, "timestamp_ms")
            if timestamp is not None:
                try:
                    expected = Decimal(str(timestamp)) * 1000
                except (InvalidOperation, ValueError, TypeError):
                    raise ValueError("timestamp must be numeric")
                if expected != expected.to_integral_value() or int(expected) != result:
                    raise ValueError("Conflicting timestamp and timestamp_ms")
            return result

        if timestamp is None:
            return time.time_ns() // 1_000_000

        try:
            value = Decimal(str(timestamp)) * 1000
        except (InvalidOperation, ValueError, TypeError):
            raise ValueError("timestamp must be numeric")
        if not value.is_finite():
            raise ValueError("timestamp must be finite")
        return int(value)

    @staticmethod
    def _canonical_json(data):
        return json.dumps(
            data,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False
        )

    def _v3_unsigned_payload(self):
        return {
            "amount_atoms": self.amount_atoms,
            "chain_id": self.chain_id,
            "fee_atoms": self.fee_atoms,
            "nonce": self.nonce,
            "public_key": self.public_key,
            "receiver": self.receiver,
            "sender": self.sender,
            "timestamp_ms": self.timestamp_ms,
            "version": self.version
        }

    def _v3_signed_payload(self):
        data = self._v3_unsigned_payload()
        data["signature"] = self.signature
        return data

    def calculate_txid(self):
        if self.version == self.CURRENT_VERSION:
            data = self._canonical_json(self._v3_signed_payload())
            return hashlib.sha256(data.encode("utf-8")).hexdigest()

        data = (
            f"{self.version}"
            f"{self.chain_id}"
            f"{self.nonce}"
            f"{self.sender}"
            f"{self.receiver}"
            f"{self.amount}"
            f"{self.fee}"
            f"{self.timestamp}"
            f"{self.public_key}"
        )
        return hashlib.sha256(data.encode()).hexdigest()

    def data_to_sign(self):
        if self.version == self.CURRENT_VERSION:
            return self._canonical_json(self._v3_unsigned_payload())

        return (
            f"{self.version}"
            f"{self.chain_id}"
            f"{self.nonce}"
            f"{self.sender}"
            f"{self.receiver}"
            f"{self.amount}"
            f"{self.fee}"
            f"{self.timestamp}"
        )

    def sign_transaction(self, private_key_hex):
        if self.version not in (self.LEGACY_VERSION, self.V2_VERSION, self.CURRENT_VERSION):
            raise ValueError("Unsupported transaction version")

        private_key = ecdsa.SigningKey.from_string(
            bytes.fromhex(private_key_hex),
            curve=ecdsa.SECP256k1
        )
        hashfunc = hashlib.sha1 if self.version == self.LEGACY_VERSION else hashlib.sha256

        kwargs = {"hashfunc": hashfunc}
        if self.version == self.CURRENT_VERSION:
            kwargs["sigencode"] = sigencode_string_canonize

        self.signature = private_key.sign_deterministic(
            self.data_to_sign().encode("utf-8"),
            **kwargs
        ).hex()
        self.txid = self.calculate_txid()

    def amount_atoms_value(self):
        if self.version == self.CURRENT_VERSION:
            return self.amount_atoms
        return self._tokens_to_atoms(self.amount, "amount")

    def fee_atoms_value(self):
        if self.version == self.CURRENT_VERSION:
            return self.fee_atoms
        return self._tokens_to_atoms(self.fee, "fee")

    @classmethod
    def amount_atoms_from_dict(cls, data):
        if data.get("version", cls.LEGACY_VERSION) == cls.CURRENT_VERSION:
            return cls._strict_int(data["amount_atoms"], "amount_atoms")
        return cls._tokens_to_atoms(data.get("amount", 0), "amount")

    @classmethod
    def fee_atoms_from_dict(cls, data):
        if data.get("version", cls.LEGACY_VERSION) == cls.CURRENT_VERSION:
            return cls._strict_int(data["fee_atoms"], "fee_atoms")
        return cls._tokens_to_atoms(data.get("fee", 0.01), "fee")

    @classmethod
    def timestamp_seconds_from_dict(cls, data):
        if data.get("version", cls.LEGACY_VERSION) == cls.CURRENT_VERSION:
            return cls._strict_int(data["timestamp_ms"], "timestamp_ms") / 1000
        return float(data.get("timestamp", 0))

    def is_valid(self):
        if self.chain_id != self.CHAIN_ID:
            return False
        if self.version not in (self.LEGACY_VERSION, self.V2_VERSION, self.CURRENT_VERSION):
            return False

        if self.version == self.CURRENT_VERSION:
            if self.amount_atoms <= 0 or self.amount_atoms > self.MAX_MONEY_ATOMS:
                return False
            if self.fee_atoms < 0 or self.fee_atoms > self.MAX_MONEY_ATOMS:
                return False
            if self.timestamp_ms < 0 or self.nonce < 0:
                return False
            if self.amount != self.amount_atoms / self.ATOMS_PER_ZYN:
                return False
            if self.fee != self.fee_atoms / self.ATOMS_PER_ZYN:
                return False
            if self.timestamp != self.timestamp_ms / 1000:
                return False
        else:
            if not math.isfinite(self.amount) or not math.isfinite(self.fee):
                return False
            try:
                timestamp = float(self.timestamp)
            except (TypeError, ValueError, OverflowError):
                return False
            if not math.isfinite(timestamp) or self.amount <= 0 or self.fee < 0 or self.nonce < 0:
                return False

        if not isinstance(self.txid, str) or len(self.txid) != 64:
            return False
        try:
            bytes.fromhex(self.txid)
        except ValueError:
            return False

        if self.sender == "SYSTEM":
            fee_is_zero = self.fee_atoms == 0 if self.version == self.CURRENT_VERSION else self.fee == 0
            if not fee_is_zero or self.nonce != 0:
                return False
            if self.public_key is not None or self.signature is not None:
                return False
            return self.txid == self.calculate_txid()

        if self.txid != self.calculate_txid():
            return False
        if not isinstance(self.public_key, str) or len(self.public_key) != 128:
            return False
        if not isinstance(self.signature, str) or len(self.signature) != 128:
            return False

        try:
            signature_bytes = bytes.fromhex(self.signature)
            public_key = ecdsa.VerifyingKey.from_string(
                bytes.fromhex(self.public_key),
                curve=ecdsa.SECP256k1
            )
            if self.version == self.CURRENT_VERSION:
                s = int.from_bytes(signature_bytes[32:], "big")
                if s > ecdsa.SECP256k1.order // 2:
                    return False
                return public_key.verify(
                    signature_bytes,
                    self.data_to_sign().encode("utf-8"),
                    hashfunc=hashlib.sha256,
                    sigdecode=sigdecode_string
                )

            hashfunc = hashlib.sha1 if self.version == self.LEGACY_VERSION else hashlib.sha256
            return public_key.verify(
                signature_bytes,
                self.data_to_sign().encode("utf-8"),
                hashfunc=hashfunc
            )
        except Exception:
            return False

    @classmethod
    def from_dict(cls, data):
        if not isinstance(data, dict):
            raise ValueError("Transaction must be an object")

        version = data.get("version", cls.LEGACY_VERSION)
        if isinstance(version, bool) or not isinstance(version, int):
            raise ValueError("version must be an integer")

        if version == cls.CURRENT_VERSION:
            unknown = set(data) - cls.V3_FIELDS
            missing = cls.V3_FIELDS - set(data)
            if unknown:
                raise ValueError(f"Unknown v3 transaction fields: {', '.join(sorted(unknown))}")
            if missing:
                raise ValueError(f"Missing v3 transaction fields: {', '.join(sorted(missing))}")
            return cls(
                version=version,
                chain_id=data["chain_id"],
                nonce=data["nonce"],
                sender=data["sender"],
                receiver=data["receiver"],
                amount_atoms=data["amount_atoms"],
                fee_atoms=data["fee_atoms"],
                public_key=data["public_key"],
                signature=data["signature"],
                timestamp_ms=data["timestamp_ms"],
                txid=data["txid"]
            )

        if version not in (cls.LEGACY_VERSION, cls.V2_VERSION):
            raise ValueError("Unsupported transaction version")
        return cls(
            version=version,
            chain_id=data.get("chain_id", cls.CHAIN_ID),
            nonce=int(data.get("nonce", 0)),
            sender=data["sender"],
            receiver=data["receiver"],
            amount=float(data["amount"]),
            fee=float(data.get("fee", 0.01)),
            public_key=data.get("public_key"),
            signature=data.get("signature"),
            timestamp=data.get("timestamp"),
            txid=data.get("txid")
        )

    def to_dict(self):
        if self.version == self.CURRENT_VERSION:
            return {
                "version": self.version,
                "chain_id": self.chain_id,
                "nonce": self.nonce,
                "sender": self.sender,
                "receiver": self.receiver,
                "amount_atoms": self.amount_atoms,
                "fee_atoms": self.fee_atoms,
                "timestamp_ms": self.timestamp_ms,
                "public_key": self.public_key,
                "signature": self.signature,
                "txid": self.txid
            }

        return {
            "version": self.version,
            "chain_id": self.chain_id,
            "nonce": self.nonce,
            "sender": self.sender,
            "receiver": self.receiver,
            "amount": self.amount,
            "fee": self.fee,
            "timestamp": self.timestamp,
            "public_key": self.public_key,
            "signature": self.signature,
            "txid": self.txid
        }

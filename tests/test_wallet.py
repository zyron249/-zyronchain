from zyron.wallet import Wallet


def test_wallet_creation_has_address_mnemonic_and_keys():
    wallet = Wallet()
    data = wallet.to_dict()

    assert data["address"].startswith("ZYN")
    assert len(data["address"]) == 43
    assert len(data["mnemonic"].split()) == 12
    assert data["private_key"]
    assert data["public_key"]


def test_wallet_recovery_returns_same_address():
    wallet1 = Wallet()
    mnemonic = wallet1.mnemonic

    wallet2 = Wallet(mnemonic=mnemonic)

    assert wallet1.address == wallet2.address
    assert wallet1.get_private_key() == wallet2.get_private_key()
    assert wallet1.get_public_key() == wallet2.get_public_key()


def test_invalid_mnemonic_is_rejected():
    try:
        Wallet(mnemonic="apple apple apple apple apple apple apple apple apple apple apple apple")
        assert False
    except ValueError:
        assert True

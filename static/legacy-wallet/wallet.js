let wallet = null;
let showPrivateKey = false;

function decimalToAtoms(value) {
    const text = String(value).trim();
    const match = /^(\d+)(?:\.(\d{0,8}))?$/.exec(text);
    if (!match) throw new Error("Use a positive decimal with at most 8 decimal places");

    const whole = BigInt(match[1]);
    const fraction = BigInt((match[2] || "").padEnd(8, "0") || "0");
    const atoms = whole * 100000000n + fraction;
    if (atoms > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Amount exceeds the safe protocol range");
    }
    return Number(atoms);
}

function canonicalV3Unsigned(tx) {
    return JSON.stringify({
        amount_atoms: tx.amount_atoms,
        chain_id: tx.chain_id,
        fee_atoms: tx.fee_atoms,
        nonce: tx.nonce,
        public_key: tx.public_key,
        receiver: tx.receiver,
        sender: tx.sender,
        timestamp_ms: tx.timestamp_ms,
        version: tx.version
    });
}

function canonicalV3Signed(tx) {
    return JSON.stringify({
        amount_atoms: tx.amount_atoms,
        chain_id: tx.chain_id,
        fee_atoms: tx.fee_atoms,
        nonce: tx.nonce,
        public_key: tx.public_key,
        receiver: tx.receiver,
        sender: tx.sender,
        signature: tx.signature,
        timestamp_ms: tx.timestamp_ms,
        version: tx.version
    });
}

function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

function hexToBytes(hex) {
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
        throw new Error("Invalid hex value");
    }

    const result = new Uint8Array(hex.length / 2);
    for (let i = 0; i < result.length; i++) {
        result[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return result;
}

async function digestHex(algorithm, bytes) {
    const hashBuffer = await crypto.subtle.digest(algorithm, bytes);
    return bytesToHex(new Uint8Array(hashBuffer));
}

async function sha256Hex(text) {
    return digestHex(
        "SHA-256",
        new TextEncoder().encode(text)
    );
}

async function walletFromPrivateKey(privateKeyHex) {
    const privateKey = hexToBytes(privateKeyHex);
    const uncompressedPublicKey = zyronSecp256k1.getPublicKey(privateKey, false);
    const publicKey = bytesToHex(uncompressedPublicKey.slice(1));
    const addressHash = await digestHex(
        "SHA-256",
        hexToBytes(publicKey)
    );

    return {
        address: "ZYN" + addressHash.slice(0, 40),
        public_key: publicKey,
        private_key: privateKeyHex.toLowerCase()
    };
}

async function privateKeyFromMnemonic(mnemonic) {
    const normalized = mnemonic.normalize("NFKD");
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(normalized),
        "PBKDF2",
        false,
        ["deriveBits"]
    );
    const seedBits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            hash: "SHA-512",
            salt: new TextEncoder().encode("mnemonic"),
            iterations: 2048
        },
        keyMaterial,
        512
    );
    const seed = new Uint8Array(seedBits);
    return digestHex("SHA-256", seed);
}

function safeWalletView() {
    if (!wallet) return "No wallet loaded.";

    const view = {
        address: wallet.address,
        public_key: wallet.public_key,
        private_key: showPrivateKey ? wallet.private_key : "HIDDEN"
    };

    return JSON.stringify(view, null, 2);
}

function updateWalletBox() {
    document.getElementById("walletBox").textContent = safeWalletView();
}

async function createWallet() {
    const entropy = crypto.getRandomValues(new Uint8Array(32));
    let privateKeyHex = bytesToHex(entropy);

    if (/^0+$/.test(privateKeyHex)) {
        return createWallet();
    }

    wallet = await walletFromPrivateKey(privateKeyHex);
    showPrivateKey = false;
    updateWalletBox();
    document.getElementById("resultBox").textContent =
        "Wallet created locally. Back up the private key offline before receiving funds.";
}

async function recoverWallet() {
    const mnemonic = document.getElementById("mnemonicInput").value.trim();

    if (!mnemonic) return alert("Please enter mnemonic");

    try {
        const wordCount = mnemonic.split(/\s+/).length;
        if (![12, 15, 18, 21, 24].includes(wordCount)) {
            throw new Error("BIP39 mnemonic must contain 12, 15, 18, 21, or 24 words");
        }

        const privateKeyHex = await privateKeyFromMnemonic(mnemonic);
        wallet = await walletFromPrivateKey(privateKeyHex);
        showPrivateKey = false;
        updateWalletBox();
        document.getElementById("mnemonicInput").value = "";
        document.getElementById("resultBox").textContent =
            "Wallet recovered locally. The mnemonic was not sent to the node.";
    } catch (error) {
        document.getElementById("resultBox").textContent = JSON.stringify({
            message: "Wallet recovery failed",
            error: error.message
        }, null, 2);
    }
}

function togglePrivateKey() {
    if (!wallet) return alert("Load wallet first");
    showPrivateKey = !showPrivateKey;
    updateWalletBox();
}

async function copyAddress() {
    if (!wallet) return alert("Load wallet first");
    await navigator.clipboard.writeText(wallet.address);
    document.getElementById("resultBox").textContent = "Address copied.";
}

async function getBalance() {
    if (!wallet) return alert("Load wallet first");

    const res = await fetch("/address/" + wallet.address);
    const data = await res.json();

    document.getElementById("resultBox").textContent = JSON.stringify(data, null, 2);
}

async function claimFaucet() {
    if (!wallet) return alert("Load wallet first");

    const res = await fetch("/faucet/" + wallet.address);
    const data = await res.json();

    document.getElementById("resultBox").textContent = JSON.stringify(data, null, 2);
}

async function getNextNonce() {
    const res = await fetch("/nonce/" + wallet.address);
    const data = await res.json();

    if (!res.ok) {
        throw new Error(data.error || "Nonce lookup failed");
    }

    return data.next_nonce;
}

async function sendZyn() {
    if (!wallet) return alert("Load wallet first");

    const receiver = document.getElementById("receiver").value.trim();
    const amountInput = document.getElementById("amount").value;
    const feeInput = document.getElementById("fee").value || "0.01";

    if (!receiver || !amountInput) {
        alert("Receiver and amount are required");
        return;
    }

    try {
        const version = 3;
        const chainId = "zyron-testnet-1";
        const nonce = await getNextNonce();
        const amountAtoms = decimalToAtoms(amountInput);
        const feeAtoms = decimalToAtoms(feeInput);
        const timestampMs = Date.now();

        const signedTx = {
            version: version,
            chain_id: chainId,
            nonce: nonce,
            sender: wallet.address,
            receiver: receiver,
            amount_atoms: amountAtoms,
            fee_atoms: feeAtoms,
            timestamp_ms: timestampMs,
            public_key: wallet.public_key,
            signature: null,
            txid: null
        };

        const dataToSign = canonicalV3Unsigned(signedTx);

        const signatureBytes = zyronSecp256k1.sign(
            new TextEncoder().encode(dataToSign),
            hexToBytes(wallet.private_key),
            {format: "compact"}
        );
        signedTx.signature = bytesToHex(signatureBytes);
        signedTx.txid = await sha256Hex(canonicalV3Signed(signedTx));

        const res = await fetch("/transaction", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(signedTx)
        });

        const data = await res.json();
        document.getElementById("resultBox").textContent = JSON.stringify(data, null, 2);

    } catch (error) {
        document.getElementById("resultBox").textContent = JSON.stringify({
            message: "Transaction failed",
            error: error.message
        }, null, 2);
    }
}

async function loadTransactions() {
    if (!wallet) return alert("Load wallet first");

    const res = await fetch("/address/" + wallet.address);
    const data = await res.json();

    document.getElementById("txBox").textContent = JSON.stringify(data.transactions || [], null, 2);
}

// Strict CSP (no inline handlers): wire buttons by data-action.
const ACTIONS = { createWallet, recoverWallet, copyAddress, togglePrivateKey, getBalance, claimFaucet, sendZyn, loadTransactions };
document.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', () => ACTIONS[button.dataset.action]());
});

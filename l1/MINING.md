# Mining ZYN with the packaged Layer-1

ZyronChain protocol v5 implements permissionless proof-of-work **issuance** while validator quorum continues to provide block finality. Public mining is not active merely because this code is present; the target network must actually have protocol v5 scheduled and activated.

## Economics

- Historical genesis + mining issuance cap: **50,000,000 ZYN**
- One ZYN: **100,000,000 atoms**
- Initial reward: **6.25 ZYN** per successful finalized mining claim
- Halving: every **4,000,000 successful finalized claims**
- Maximum mining claims per finalized block: **1**
- Initial work target: **20 SHA-256 bits**
- Genesis allocations reduce the mining budget atom-for-atom
- Transaction fee burns remain permanently burned and never reopen mining supply

## Run

Use a ZyronChain encrypted wallet and a local or HTTPS RPC endpoint. The packaged miner deliberately refuses legacy plaintext private-key JSON. On POSIX systems both `wallet.json` and `wallet.password` must be owner-only before the miner reads either file (`chmod 600` recommended).

```sh
chmod 600 /path/to/wallet.json /path/to/wallet.password
npm run mine -- \
  --genesis /path/to/genesis.json \
  --key /path/to/wallet.json \
  --password-file /path/to/wallet.password \
  --rpc http://127.0.0.1:9137
```

Useful options:

- `--once` — stop after one accepted claim submission
- `--batch-size <n>` — hashes attempted between finalized-tip refreshes

The miner decrypts and signs locally. It never uploads the private key or password. Remote RPC must use HTTPS; plaintext HTTP is accepted only for loopback.

Mining work is bound to the chain ID, miner account nonce/address/public key, next block height, previous finalized block hash and deterministic reward. A tip change invalidates old work.

## Important limitation

This is not Nakamoto chain-selection mining. Hash power competes for ZYN issuance, while the configured validator quorum still proposes and finalizes blocks. A validator proposer may censor a mining claim it received; public-testnet evidence must measure inclusion fairness, stale work, hardware skew, mining-pool concentration and target calibration before mainnet economics are frozen.

For the full design and threat model in the source repository, see `docs/MINING.md` and `docs/L1_THREAT_MODEL.md`.

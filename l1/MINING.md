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

Use a ZyronChain encrypted wallet and a local or HTTPS RPC endpoint. The packaged miner deliberately refuses legacy plaintext private-key JSON. On POSIX systems both `wallet.json` and `wallet.password` must be owner-only before the miner reads either file (`chmod 600` recommended). Secret paths must be real regular files rather than symbolic links; the miner validates the exact opened file descriptor and reads from that same descriptor so path replacement during validation fails closed.

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

For the self-contained one-click runtime, the first-launch bootstrap additionally requires the custody root to resolve to a real directory without symbolic-link/junction traversal before wallet material is created or chmodded. Existing wallet/password paths are checked with `lstat` and must be regular non-symlink files before any permission mutation. First creation remains exclusive (`wx`), and an existing wallet with a missing password fails closed rather than replacing custody material. An inactive public-mining profile still exits before touching the custody path at all.

The bundled `miner-network-profile.json` is itself part of the reviewed package boundary. Before parsing activation, chain ID, genesis path or RPC settings, the launcher resolves that exact profile through the package-owned regular-file guard, rejects symlink/junction/reparse substitution and non-regular files, and requires the canonical profile path to remain inside the canonical package root on every supported platform. It then opens and reads the same validated descriptor, rechecks descriptor/path identity on POSIX, and caps the control file at **64 KiB** so replacement or concurrent growth fails closed instead of causing an unbounded startup read. Because Windows lacks the POSIX `O_NOFOLLOW` boundary used here, the complete package-component/canonical-path check is repeated immediately after descriptor open and again after the bounded read; detected junction/reparse substitution fails before any returned control bytes can be parsed. The profile must still contain exactly the reviewed schema fields; an inactive profile continues to exit with status 78 before custody is touched.

The bundled genesis is part of the reviewed miner package boundary. Before custody is touched, the launcher requires the configured genesis path to be relative, walks every package-owned path component with `lstat`, rejects symbolic links/junctions and non-directory parents, requires the final object to be a regular file, canonicalizes both the package root and genesis path, and verifies that the canonical genesis remains inside the package on every supported platform. This complements the miner's own bounded local-control-file checks: the supplied genesis is limited to **256 KiB**, must be a regular-file descriptor, and on POSIX refuses symlink/non-blocking special-file substitution before JSON or canonical chain validation.

Before hashing, the miner reconstructs the canonical genesis hash from the supplied genesis file and requires both the RPC chain ID and RPC genesis hash to match exactly. The same identity check is repeated while mining, so an endpoint that switches to a different network fails closed instead of silently wasting work.

Protocol and nonce state are sampled between two validated finalized-status reads. If the finalized height or tip hash changes while those RPC reads are in flight, the sampled state is discarded before any hashing begins. This prevents a mixed old-tip/new-state challenge from consuming a hash batch.

Mining work is bound to the chain ID, miner account nonce/address/public key, next block height, previous finalized block hash and deterministic reward. A tip change invalidates old work.

## Release-candidate boundary

The cross-platform release-candidate workflow is deliberately **not** a public miner release. It uses one exact reviewed Node.js runtime version to build Windows, macOS and Linux candidates, reruns the fail-closed bootstrap smoke, emits a production SBOM and SHA-256 manifest, and records source/runtime metadata. Non-PR candidate evidence may receive GitHub artifact attestations.

Every generated `RELEASE-METADATA.json` must remain explicitly non-publishable while launch gates are closed:

- `publicMiningActivated=false`
- `releaseEligible=false`
- `platformSigningVerified=false`
- `publicationAllowed=false`

A successful candidate workflow therefore proves packaging/provenance mechanics only. It does **not** authorize a GitHub Release, website download CTA, public mining, public testnet, or mainnet. Promotion requires separately reviewed platform signing/notarization where applicable, versioned immutable GitHub Release assets whose checksums/provenance match the reviewed source, and explicit satisfaction of the public-mining activation gates. The website must continue to fail closed until those requirements are evidenced.

## Important limitation

This is not Nakamoto chain-selection mining. Hash power competes for ZYN issuance, while the configured validator quorum still proposes and finalizes blocks. A validator proposer may censor a mining claim it received; public-testnet evidence must measure inclusion fairness, stale work, hardware skew, mining-pool concentration and target calibration before mainnet economics are frozen.

For the full design and threat model in the source repository, see `docs/MINING.md` and `docs/L1_THREAT_MODEL.md`.
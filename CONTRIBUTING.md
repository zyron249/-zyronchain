# Contributing to ZyronChain

Thank you for helping review and test ZyronChain. The canonical consensus client is the TypeScript L1 in [`l1/`](l1/). The Python/Flask tree is a legacy compatibility testnet only.

## Public testers

Start with [`docs/PUBLIC_TEST.md`](docs/PUBLIC_TEST.md). The supported external path is the loopback two-validator network:

```sh
cd l1
npm ci
npm run typecheck
npm run devnet
```

`npm run devnet:check` is the automated variant used in CI. This is not a hosted public testnet and does not activate mainnet.

## Development setup

**Canonical L1** (Node.js 22+; Linux/macOS or WSL2 for validators):

```sh
cd l1
npm ci
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
```

**Legacy Python node** (optional):

```sh
pip install --require-hashes -r requirements.txt
PYTHONPATH=. pytest -q
```

Copy [`.env.example`](.env.example) as a variable checklist. The processes do not auto-load `.env`. Never commit a real `.env`, keystore, password file, or signer token.

## Rules that keep the chain reviewable

1. **Deterministic replay.** Consensus, state, and signing changes must remain replay-safe and include regression tests.
2. **Do not invent launch facts.** Do not add fake public chain IDs, RPC URLs, faucet/explorer endpoints, or flip `publicTestnetActivationAllowed` / `mainnetActivationAllowed` without independently reviewed evidence.
3. **Do not commit secrets.** Keep operator files outside the repository. `.gitignore` already covers the usual names (see [`.env.example`](.env.example)).
4. **No hidden admin authority.** Do not introduce emergency mint, recovery, or founder-only bypasses.
5. **Keep canonical and legacy separate.** Do not rebrand `zyron-testnet-1` or the quarantined Render hostname as the canonical L1.

## Security reports

Follow [`SECURITY.md`](SECURITY.md). Do not open a public issue that includes exploit details, keys, or live endpoints.

## Pull requests

- Prefer small, reviewable changes with tests for consensus/crypto/RPC boundaries.
- Update operator docs when you change a tester-visible command or RPC path.
- CI already covers Python 3.11/3.12, L1 on Node 22/24, and `npm run devnet:check`. A green run is not activation approval.

Maintainer/release continuity is defined in [`docs/L1_MAINTAINER_SUCCESSION.md`](docs/L1_MAINTAINER_SUCCESSION.md). Repository write access is not validator voting power.

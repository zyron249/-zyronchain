# Legacy Render quarantine boundary

The Python/Flask network in the repository is archived compatibility/replay material. It is not the canonical TypeScript Layer-1, is not a public-testnet/mainnet candidate, and must not be presented as a canonical RPC, explorer, bootstrap, miner, checkpoint, or release endpoint.

## Fail-closed public-service quarantine

Python automatically imports `sitecustomize.py` when the repository root is on `PYTHONPATH`. The hook is inert unless the service explicitly sets:

```text
ZYRON_LEGACY_PUBLIC_QUARANTINE=1
```

When that exact value is present, every Flask request is intercepted before route handling and returns HTTP `410 Gone` with a stable JSON body identifying the endpoint as the archived `legacy-python-compatibility-testnet`, `canonical: false`, `Cache-Control: no-store`, and `X-ZyronChain-Network: legacy-quarantined`.

This is a deployment quarantine, not a consensus migration. Archived Python code remains available for compatibility/replay testing. Local compatibility behavior is unchanged when the environment variable is absent.

## Render evidence required before closing deployment blocker

For every public legacy Python Render service:

1. Set `PYTHONPATH=.` so Python startup loads the repository `sitecustomize` hook.
2. Set `ZYRON_LEGACY_PUBLIC_QUARANTINE=1`.
3. Deploy/restart the service and verify ordinary routes such as `/`, `/health`, `/peer/status`, `/chain`, and mutation routes return `410 Gone` with `X-ZyronChain-Network: legacy-quarantined`.
4. Record the service ID/name, branch, auto-deploy state, deploy commit, deploy status, and quarantine response evidence in the deployment/readiness tracker.
5. Keep `publicTestnetActivationAllowed=false` and mainnet activation fail-closed until all other external evidence gates are also satisfied.

A legacy service may alternatively be suspended/decommissioned or detached from canonical `main`; this document does not require keeping it online.

## Security invariants

The quarantine is intentionally fail-closed and requires exact value `1`; permissive values such as `true` do not activate it. The canonical TypeScript L1 and the static website do not depend on this hook. This change does not establish public-mining, public-testnet, or mainnet readiness and does not weaken any activation, finality, signing, custody, or release gate.

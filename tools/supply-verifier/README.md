# Supply verifier

Read-only tool that replays ZyronChain from the pinned genesis and reconciles the supply to exactly 50,000,000 ZYN. See [docs/SUPPLY_VERIFIER.md](../../docs/SUPPLY_VERIFIER.md).

Trust assumptions: the verifier trusts the l1 consensus code at the verified commit and is not an independent second implementation. Endpoints are not proven independent; two URLs may front the same node.

Build with the Node version in [.nvmrc](.nvmrc).

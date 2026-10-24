# Where v1 (undomained) transfers are still accepted, and a v2-default proposal

Status: **proposal only.** This document changes no code, consensus rule or supply.

A v1 transaction is signed over `canonicalJson(tx)`. A v2 transaction is signed over
`canonicalJson({ domain: "zyronchain/transaction/<kind>/v2", payload: tx })`
(`l1/src/transaction.ts:660-682`). v1 signatures carry no domain separation.

## Inventory (main @ b5ea11b)

### Consensus (l1). Not changed by this proposal
| Location | What it does |
| --- | --- |
| `l1/src/chain.ts:1453-1457` | `assertTransactionVersionForProtocol`: protocol < 3 **requires** v1; protocol ≥ 3 requires v2. Called at `chain.ts:684, 795, 861, 943, 1025` (block apply, mempool and validation paths). |
| `l1/src/transaction.ts:465` | Structural validation accepts `version` 1 or 2. |
| `l1/src/transaction.ts:671-682` | `verifyForTransactionVersion`: v1 is verified undomained. |
| `l1/src/types.ts:144, 173, 230, 253, 270` | Transaction types are `version: 1 \| 2`. |

### Library and CLI defaults (l1)
| Location | Default |
| --- | --- |
| `l1/src/transaction.ts:248` | `createTransfer(..., version = 1)` |
| `l1/src/transaction.ts:76, 111, 130, 175, 194, 219, 361` | Other builders also default to `1`. |
| `l1/src/rpc-client.ts:15-19`, `l1/src/cli.ts:685` | The CLI picks the version from the node's protocol (1-2 → v1, 3/5/6 → v2). Already correct. |
| `l1/src/remote-signer-service.ts:139-149` | Remote signer accepts request version 1 (v6 intents require version 2). |

### Wallets
| Location | Behaviour |
| --- | --- |
| `website/app/zyron-wallet-core.js:49-53` | `defaultTransferVersion`: v1 only for `zyron-wallet-testnet-1`, v2 for every other chain. |
| `website/app/zyron-wallet-core.js:334, 374` | Builds and verifies v1 or v2. |
| `website/app/index.html:273-274`, `website/app/app.js:585` | Version selector; the default follows `defaultTransferVersion`. |
| `website/testnet/testnet.js:228, 238-241` | Accepts 1 or 2 but **requires** the value to equal the network's `status.transactionVersion`. |
| `snap/src/zyron/transfer.ts:152, 225-230` | Snap accepts and signs v1 or v2 as requested. |
| `snap/site/index.html:55` | Demo dapp already defaults to v2. |
| `tools/site/test-testnet-browser.mjs:51` | Test fixture uses v1 for `zyron-wallet-testnet-1`. |

## Why no wallet default was changed

Every wallet already defaults to v2 except on `zyron-wallet-testnet-1`. That chain runs
protocol version 1, and `chain.ts:1453-1457` rejects any v2 transaction there. Switching the wallet
default to v2 on that chain would make every testnet send fail, so there is no
safe wallet-only change. Removing v1 requires a protocol change on that network, which is a
consensus decision.

## Proposal
1. **Wallet testnet upgrade (consensus, owner decision):** schedule a `protocol_upgrade`
   on `zyron-wallet-testnet-1` to protocol ≥ 3. After activation the chain only
   accepts v2. The wallets switch automatically: `testnet.js` reads
   `status.transactionVersion`, and the PWA rule can drop its special case.
2. **Wallet follow-up (after step 1):** make `defaultTransferVersion` return 2 for all
   chains, and update `tools/pwa-wallet/test-core.mjs:370-375` and
   `tools/site/test-testnet-browser.mjs:51` at the same time.
3. **Library hygiene (non-consensus, separate PR):** change the builder defaults in
   `l1/src/transaction.ts` to require an explicit version, so that no caller signs v1 by accident.
   This touches many l1 tests and is why it is not done here.
4. **Long term:** once no network runs protocol < 3, retire v1 acceptance in a versioned
   protocol rule. Never retire it retroactively, because historical blocks must still validate.

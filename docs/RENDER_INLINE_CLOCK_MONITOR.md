# Render inline validator-clock fail-stop monitor

Status: private/adversarial rehearsal safety control only. This does not authorize a public testnet or mainnet.

The live Render service currently starts `node scripts/render-private-testnet.mjs` directly. Render's connected control surface does not expose a start-command mutation, so the repository-level supervisor wrapper cannot be assumed active merely because its source file exists.

`render-clock-preload.mjs` closes that deployment gap without changing consensus or validator signing rules. Render sets `NODE_OPTIONS=--import=./scripts/render-clock-preload.mjs`; the preload activates only when the main Node script is `render-private-testnet.mjs`. npm/build/validator child Node processes therefore import the module but remain inactive.

When active, the preload polls the launcher's loopback `/readyz` endpoint. Sampling errors during startup/redeploy are ignored because they are not proof of clock rollback. Only an explicit `validator-clock-unhealthy` readiness reason triggers the safety action. On such a fault the preload requests SIGTERM so the launcher executes its existing graceful gateway/validator shutdown, and a `beforeExit` guard forces final process exit code 70 even though the launcher's generic SIGTERM path normally exits zero.

This is deliberately redundant with the repository's separate Render supervisor and with the core stale-signing-clock fix. The layers have different purposes:

- the core fix prevents a stale consensus timestamp from being mistaken for a local clock rollback;
- the validator clock guard still fail-stops a genuine >1 second rollback;
- the inline Render monitor ensures the existing direct launcher start command cannot remain superficially live after that genuine fail-stop;
- production/public-testnet operators still require independent hosts, persistent anti-equivocation state, production signer custody and an explicit orchestration/restart policy.

`render-clock-preload-rehearsal.mjs` supplies a healthy then faulted synthetic readiness stream, verifies graceful SIGTERM is requested, and requires final exit code 70. Dedicated CI also imports the preload during an ordinary npm typecheck to prove non-launcher Node processes are unaffected.

# ZyronChain hosted duration-soak evidence

Status: **prepared external hosting evidence format**. This document does not claim that a real always-on soak has already occurred, does not prove independent operators, and does not certify mainnet.

## Purpose

The connected Render Free Web Service is intentionally classified as smoke-only because the platform may stop it after inactivity. A sustained uptime claim therefore needs reviewed always-on compute rather than artificial self-ping traffic.

`docs/l1-hosted-duration-soak-policy.json` and `l1/scripts/verify-hosted-duration-soak-evidence.mjs` define the first objective evidence gate for that future always-on rehearsal.

## Initial engineering threshold

The current public-testnet engineering policy requires a real hosted evidence window of at least **6 hours** (`21600` seconds). This is an initial testnet rehearsal threshold, **not** a mainnet SLA, availability promise, or economic policy.

During the evidence window the verifier requires:

- one exact tested commit and release-artifact SHA-256;
- one stable chain ID and genesis hash;
- strictly increasing sample timestamps;
- non-decreasing finalized height, with no same-height tip-hash change;
- finalized-height progress over the window;
- finality gaps no greater than 180 seconds;
- at least the equivalent of 3/4 validators ready at every sample;
- memory utilization no greater than 80% of the declared runtime limit;
- zero reported validator-clock faults;
- zero reported persistence faults;
- every reported restart explicitly accounted for, using the same data, preserving genesis identity and resuming finality;
- provider, region and declared failure-domain metadata.

A failed condition rejects the evidence instead of lowering a safety threshold to restore liveness.

## Real evidence mode

A real collector should produce an evidence JSON with `evidenceMode: "hosted-duration-soak"` and invoke:

```sh
node l1/scripts/verify-hosted-duration-soak-evidence.mjs \
  --policy docs/l1-hosted-duration-soak-policy.json \
  --evidence hosted-duration-soak.json \
  --out hosted-duration-soak-verified.json
```

A successful real verification may set `sustainedUptimeEvidenceValidated: true`, but still sets:

- `independentOperatorEvidenceProven: false`;
- `externalReviewRequired: true`;
- `mainnetCertified: false`.

One-provider uptime evidence is not multi-region or independent-operator evidence.

## Synthetic CI vectors

Required CI runs a synthetic positive vector and a negative vector containing a finalized-height regression. Synthetic mode uses `--test-vector` and **must** emit:

- `syntheticValidationOnly: true`;
- `sustainedUptimeEvidenceValidated: false`;
- `publicTestnetActivationEvidence: false`;
- `mainnetCertified: false`.

Synthetic vectors exist only to regression-test the evidence verifier. They cannot close a real hosting, operator, audit, custody or activation gate.

## Hosting boundary

Do not use artificial keepalive/self-ping traffic to make a Free service look continuously hosted. Issue #249 remains open until reviewed always-on compute is actually provisioned and real duration evidence is collected. A separate independent-operator challenge remains required for operator/failure-domain independence.

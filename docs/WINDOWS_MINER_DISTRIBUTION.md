# Windows miner distribution boundary

Windows end-user miner materialization is currently **quarantined**. The repository retains the Windows ZIP tooling and launcher contract for future use, but CI must not create, attest, upload, or publish a `ZyronMiner-windows-<arch>.zip` candidate until the handle-relative filesystem custody prerequisite tracked in #761 is implemented and the dependent release-root/bundle-root/nested-destination stop-ships (#757, #683, #636) are resolved with regression evidence.

While quarantine is active, CI proves the stronger fail-closed property instead: invoking the self-contained miner packager must fail before `miner-release` is created or any candidate byte is materialized. There is no environment or CLI bypass for this quarantine. Existing activation gates remain closed; quarantine is not evidence of packaging readiness or public mining readiness.

When packaging is eventually restored, the candidate must still retain `publicMiningActivated=false`, `releaseEligible=false`, `platformSigningVerified=false`, and `publicationAllowed=false` until the separate reviewed activation and release-governance requirements are satisfied. The website must not expose a public miner download merely because packaging mechanics become available.

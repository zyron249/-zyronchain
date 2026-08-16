# Windows miner distribution boundary

The Windows end-user candidate is built from the reviewed self-contained miner bundle as `ZyronMiner-windows-<arch>.zip`. The ZIP contains the bundled Node.js runtime, production dependencies, miner code, network profile, documentation, and the double-click `ZyronMiner.cmd` launcher. Users do not need Git, npm, Node.js, or PowerShell scripts to start the packaged candidate.

The ZIP is still **candidate evidence only** while launch gates are closed. CI must keep `publicMiningActivated=false`, `releaseEligible=false`, `platformSigningVerified=false`, and `publicationAllowed=false`. The website must not link this candidate as a public miner until a reviewed immutable release asset exists, its SHA-256/provenance matches the reviewed source, Windows signing has been verified where required, and public-mining activation is explicitly approved.

The inactive launcher must fail closed before creating or modifying wallet custody. Packaging availability is not network activation.

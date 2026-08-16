# Windows miner package security invariants

- The end-user ZIP is generated only from the self-contained miner bundle produced on the Windows CI runner.
- The archive must contain the bundled `node.exe` and `ZyronMiner.cmd`; no Git/npm/PowerShell bootstrap download is required for normal startup.
- The canonical network profile remains inactive during candidate builds.
- Candidate creation must not imply publication authorization or public-mining activation.
- Inactive bootstrap must exit before wallet custody is created or modified.
- Public website linking requires a separately reviewed immutable release, matching checksum/provenance, and the required platform-signing evidence.

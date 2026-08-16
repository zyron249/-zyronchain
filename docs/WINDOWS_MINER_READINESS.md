# Windows miner readiness checklist

The end-user candidate is ready for review when CI proves all of the following on the exact PR head: general ZyronChain CI green; Standalone L1 Node 22 and Node 24 green; Miner Release Candidate Windows job green; the generated ZIP expands successfully and contains `ZyronMiner.cmd` plus bundled `node.exe`; dependency audit and SBOM generation pass; inactive bootstrap creates no custody; SHA-256 manifest is generated.

This checklist does not authorize public distribution. Before the website download control can become active, the reviewed candidate must be promoted to an immutable versioned release with matching provenance/checksum and required Windows signing evidence. Public mining activation remains a separate gate.

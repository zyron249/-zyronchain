# Miner provenance snapshot boundary

Miner candidate provenance is local, unsigned release-candidate evidence only. It does not authorize signing, publication, public mining, public testnet, or mainnet activation.

`package.json`, the candidate SBOM, and an existing provenance document are now read through a descriptor-bound snapshot. Before opening, the pathname must be a canonical regular file. The reader then opens with `O_NOFOLLOW` where supported, verifies the opened descriptor still matches the pre-open device/inode/size/mtime/ctime snapshot, reads bytes from that same descriptor, and verifies that the descriptor snapshot did not change while the bytes were consumed.

This closes the pathname-replacement window between validation and read and fails closed on in-place mutation during provenance construction or verification. Regression coverage exercises both replacement-before-open and mutation-during-read cases.

The authority object remains `{ type: "local-evidence-only", signed: false, published: false }`; this hardening does not change any activation or release-promotion gate.
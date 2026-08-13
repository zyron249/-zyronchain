# Stored-log replay byte bounds

Status: **pre-public-testnet recovery/security control**

This control applies to the canonical finalized-block log (`blocks.ndjson`) and validator anti-equivocation journal (`signing-journal.ndjson`). These files are authoritative local recovery inputs. Corrupt, replaced, or unexpectedly large records must fail closed without forcing memory growth proportional to an attacker-controlled line.

## Invariants

- Finalized-block replay accepts at most **2,500,000 bytes** of line content before UTF-8 string and JSON materialization.
- Signing-journal replay accepts at most **1,024 bytes** of line content before UTF-8 string and JSON materialization.
- The reader processes bounded binary chunks and stops on an oversized record before retaining an unbounded newline-free line.
- Newline-terminated and EOF-final records use the same limit.
- A trailing `\r` immediately before `\n` is treated as the CRLF delimiter and does not weaken the content limit.
- The reader reports normalized content bytes separately from the exact serialized bytes consumed, so finalized-log offsets remain correct for LF, CRLF and EOF-final records.
- An accepted EOF-final finalized record is separated with one canonical LF before the next finalized append; the new block range begins after that separator and durable byte accounting includes it.
- Block ranges cover JSON content only; delimiter bytes are never parsed as part of a block.
- Oversized authoritative records are never truncated, skipped, repaired, or partially trusted; startup/replay fails closed.
- Existing canonical writers remain LF-delimited. Compatibility behavior exists only so recovery does not regress on otherwise valid CRLF-delimited or clean EOF-final local records.

## Evidence

`l1/test/stored-log-line-bounds.test.ts` covers oversized newline-terminated and newline-free finalized-block inputs, equivalent signing-journal inputs, and a valid CRLF signing-journal replay case.

`l1/test/finalized-log-offset-accounting.test.ts` replays CRLF and EOF-final finalized records, appends another finalized block, reads both blocks by stored byte range, verifies checkpoint byte counts against the physical log and performs a second restart.

This hardening is availability/recovery evidence only. It does not authorize public mining, public testnet, mainnet, or production validator custody.
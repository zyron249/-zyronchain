# Inbound P2P UTF-8 decode memory boundary

Native inbound P2P frame decoding is fail-closed under one shared byte budget. While a complete frame is parsed, the decoder can transiently retain three frame-sized representations at once: the encoded body buffer, the JavaScript UTF-8 string created by `Buffer.toString("utf8")`, and the decoded JSON object graph.

The decoder therefore reserves three frame-sized allowances before JSON parsing. The UTF-8-string allowance is released immediately after `JSON.parse` completes; retained-frame ownership continues to hold only the encoded-body and decoded-value allowances until the caller explicitly releases the frame.

Invalid JSON, JSON-complexity rejection, budget rejection, truncation, timeout and other failure paths release every acquired allowance. Existing frame-size, nesting/cardinality, trailing-byte, stream timeout and authenticated peer/chain boundaries remain unchanged.

This is a transient heap-accounting hardening only. It is not evidence of Sybil resistance, target-hardware capacity, public-testnet readiness or mainnet readiness, and it does not relax any activation gate.

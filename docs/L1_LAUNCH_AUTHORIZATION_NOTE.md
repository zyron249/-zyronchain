# Authorization scope note

`docs/l1-launch-authorization.json` is the global repository launch-authorization authority.

Profile-specific safety files such as the private-testnet preflight and Render Free smoke profile are intentionally not launch authorities. Their local `...Authorized=false` fields mean that those profiles cannot self-promote into public testnet or mainnet; they do not override the global governance authorization.

Global authorization therefore coexists with profile-local non-authorization and with activation gates that remain evidence-dependent.

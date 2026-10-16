# Website release-pin CI custody boundary

The Website Canonical Release Pin CI is a release/security boundary. It validates that website/release.js points at the reviewed pull-request base commit, that no canonical L1/security changes escape that pin, and that the website preserves its offline browser/CSP and mining-disclosure requirements.

The workflow therefore uses only an immutable reviewed checkout action SHA, disables checkout credential persistence, and fetches full history only for the release-pin comparison. A focused policy verifier rejects mutable action references, re-enabled credentials, loss of full-history checkout, or removal of the core release/security assertions.

This hardening does not authorize miner publication, public mining, public testnet, or mainnet. Those activation gates remain independently fail-closed.

## Browser policy: exact CSP comparison (round 11)

The gate compares each page's Content-Security-Policy directive by directive with an exact source list instead of searching for substrings. Each page must carry exactly one CSP meta tag in the reviewed form, with no repeated directive and no directive outside the reviewed set. `connect-src` must be exactly `https://zyron-open-testnet.onrender.com` on `website/index.html` and `website/wallet.html` (the open-testnet status probe) and exactly `'none'` on `website/validator.html` and `website/mining.html`. `scripts/test-website-release-pin-browser-policy.mjs` runs the gate's inline program against copies of the real pages and must see it refuse a look-alike host, extra or wildcard connect sources, a duplicate directive placed first, a second CSP meta tag and widened `script-src`/`object-src`. The Website Release Pin Action Custody Policy CI runs these tests and also triggers on `website/*.html`.

## Browser policy: active CSP tag in `<head>` (round 12)

An exact policy is only useful if the browser applies it. The gate also requires that the CSP meta tag is an active element of `<head>` that comes before anything the page loads: only the doctype, `<html lang="en">`, `<head>`, other `<meta>` tags and a plain `<title>` may precede it. A CSP tag inside an HTML comment, `<title>`, `<noscript>`, `<template>` or `<textarea>`, a tag outside `<head>`, or a tag placed after a script or stylesheet is refused. The same mutation test covers each of these cases.

## Browser policy: HTML whitespace only (round 13)

HTML separates tags and attributes, and CSP separates directive names and sources, only with ASCII whitespace: TAB, LF, FF, CR and SPACE. JavaScript's `\s` also matches other characters such as U+00A0 (no-break space), U+000B (vertical tab), U+2003 (em space) and U+FEFF, which a browser reads as text. Before the CSP tag such a character closes `<head>`; inside the tag it breaks the meta element; inside the policy it turns a directive into an unknown name that the browser ignores. In each case the browser does not apply the reviewed policy. The gate's structural checks therefore use `[\t\n\f\r ]` instead of `\s`, and the mutation test covers these characters before the tag, inside the tag and as the directive separator.

Any change to `.github/workflows/website-release-pin-ci.yml` must update `WEBSITE_RELEASE_PIN_WORKFLOW_SHA256` in the same pull request, and the custody policy job must be green before merge.

# Admin console

Open `/admin` on the API origin. The page asks for `ADMIN_TOKEN` and keeps it in `sessionStorage` for that tab.

The API is disabled with HTTP 503 when `ADMIN_TOKEN` is empty. In production the process refuses to start unless the token is at least 24 characters.

## Actions

- Overview: operators, outstanding points, open flags, active season.
- Search by Telegram id, username, or referral code.
- Ban or unban. Banned operators cannot cycle, upgrade, claim, or link.
- Resolve a flag. Resolving subtracts that flag's weight from the abuse score and does not delete points.
- Export a Season snapshot. The file has `conversionRate: null` and `automaticPayout: false`. It omits Telegram ids.
- Close the active season. This sets `ends_at` and does not pay anyone.
- Release a watch-address claim if an operator linked the wrong public address.

Every one of those actions is written to `admin_audit`.

The console cannot mint ZYN, broadcast a transaction, or read a private key. It does not have those features because the game is not allowed to grow or move token supply.

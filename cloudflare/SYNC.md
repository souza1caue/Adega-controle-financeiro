# Synchronization and historical data

## Live order notifications (2026-10-21)

The root entry shows Caixa, Cozinha and Admin. Operational entry uses
`POST /api/access` with `front` or `kitchen`, without a password or registered
device. This intentionally makes those operational roles available to anyone
who opens the system. Signed 24-hour tokens preserve the existing role limits,
renew automatically when needed, and do not create D1 device records.
Admin still requires its administrative login; operational tokens cannot grant
administrative privileges. The front retains cashier name identification for
audit attribution. Legacy QR and authorized-device APIs remain compatible.
The top navigation switches operational roles through the same URL.

Authenticated, visible clients obtain a signed 60-second connection ticket from
`POST /api/live-ticket` and open `/api/live` with a same-origin WebSocket.
The SQLite-backed `OrderLive` Durable Object uses the hibernation API and sends
only `changed` signals after successful mutations. Business records always come
from the authorized incremental state API. No business data is broadcast.
Connections renew authorization every four minutes; the server stops publishing
to connections older than five minutes.

While connected, clients keep a safety state read approximately once per minute.
Disconnected operation retains the existing refresh intervals (3 seconds for
front/kitchen/printer), with backoff for socket reconnection. Hidden/offline
clients close the socket; reconnect and return online reconcile state.
This reduces idle requests but does not remove Cloudflare Free quotas.

An active kitchen screen acknowledges batches via `kitchen.received`. The first
server timestamp is preserved on retry and displayed to the front with the delay
from order creation. This confirms receipt by the screen, not a human or printer.
Preparation transitions use conditional updates and cannot regress after delivery.
Printing and acknowledgements preserve concurrent changes to other fields.

New checkouts carry a per-tab retry key retained in sessionStorage until success.
The key is scoped to the authenticated operator/device. A receipt is inserted into
`checkout_requests` in the same transaction as sales, kitchen and stock changes.
Repeated and simultaneous attempts return the original order without repeating
financial effects. Keys remain in D1; deleting them would remove retry protection.
Older clients without a key retain legacy behavior. Saved mutations remain
successful even if notification delivery or the following screen refresh fails.

Local end-to-end test against a disposable local database:

```powershell
npx.cmd wrangler d1 migrations apply controle-adega --local --persist-to .wrangler/kitchen-flow-test
npx.cmd wrangler dev --local --port 8788 --persist-to .wrangler/kitchen-flow-test --var ADMIN_PASSWORD:local-kitchen-test --var SESSION_SECRET:local-kitchen-secret
# In a second terminal:
node scripts/validate-kitchen-live.mjs
```

The script refuses production URLs. It checks real WebSockets, simultaneous
retries, kitchen acknowledgement, ready notifications, reconnect and delivery.
Local timings do not measure production latency.

## State and history

Sales, payments, cancellations and stock changes still commit immediately to D1.
No financial record depends on a browser-local queue or on closing the cash.

`GET /api/state` bootstraps catalog, customer accounts, cash archive summaries,
current cash transactions and current kitchen work. Historical sales, receipts,
operating costs and stock movements are not reloaded on every refresh.

`GET /api/state?since=<cursor>` uses the indexed `record_changes` journal.
The database triggers cover inserts, updates, deletes and atomic balance changes,
including writes from import/maintenance scripts. Each key keeps only its newest
revision (or deletion tombstone). The sequence cursor is captured before reads;
changes occurring during a response are replayed on the next request. Large
change sets are returned in pages of 500 and drained before rendering. Never
truncate this journal without forcing clients to bootstrap again.

`GET /api/history` authorizes the same role as live sync. Responses are limited
to 200 records and use date/id keyset pagination. Reports fetch only their chosen
cash or operational date range, including sales after midnight in a cash opened
the previous day. They finish loading all pages before exposing totals/exports.
Stock and kitchen history have explicit buttons for older pages. Customer
payment history is fetched when opening that customer's account.

Browser caches are in memory and scoped to the login. Revision-aware merging
prevents a delayed history request from undoing a cancellation or resurrecting
a deletion. Bootstrap resets invalidate historical caches. No API data is cached
by shared HTTP caches (`Cache-Control: no-store`).

Fallback automatic refresh: front desk/kitchen/printer 3 seconds, admin cash 15 seconds,
stock 30 seconds, other admin pages 60 seconds. Hidden tabs stop automatic
requests; returning online or to the tab requests changes. Polls do not overlap,
and writes always request an immediate refresh. Transient network/quota errors
preserve authentication and show an update warning instead of logging users out.

New cash closings store `closing_summary` (sales/cost/profit, breakdown and
cost completeness) alongside existing settlement totals and product summaries.
Historical audit details remain in D1. A closing summary is a snapshot at closing;
period reports can still load detailed records, including later corrections.
Existing closed cash sessions are not rewritten or recomputed automatically.

The admin synchronization counter sums D1 `meta.rows_read` for successful state
queries in that tab. It excludes authentication, history requests, writes, other
tabs/apps and other devices. It is not an account-wide quota meter. The Cloudflare
D1 dashboard remains the source for daily account usage. Additional indexes and
revision triggers trade a small amount of write work for avoiding repeated full
history reads; they do not remove Free plan quotas.

Validation: `npm test`, `npm run check`. Incremental tests seed 2,000 archived sales,
check that idle synchronization makes two indexed data queries, replay more than
500 changes, simulate two devices, cancellations/deletions, late history responses,
rollback, authorization, operational midnight boundaries and immutable D1 binds.

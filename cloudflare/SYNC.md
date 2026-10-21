# Synchronization and historical data

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

Automatic refresh: front desk/kitchen/printer 3 seconds, admin cash 15 seconds,
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

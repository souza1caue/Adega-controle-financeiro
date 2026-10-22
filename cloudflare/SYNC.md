# Direct application refresh

The application has returned to its previous full-snapshot flow.
GET /api/state reads all records and stock balances, filters by the current role,
and returns the complete state on every request. A since parameter does not
activate incremental responses. Sales and history are immediately available in
memory; opening a report no longer fetches additional history pages.

Every active module refreshes every three seconds, including administrative
screens. Module selection draws the destination immediately and refreshes it
in the background. There is no module snapshot cache, client WebSocket, cursor
merge, or serialized refresh queue in the current application. Responses from
an earlier module selection are discarded. Errors do not clear a valid login
unless the server explicitly rejects authentication.

Caixa and Cozinha remain available from the same module chooser without a
password or registered device. Admin still requires its administrative login.
Cashier name identification has been removed. Devices can enter and send orders
without registering a name. Old cached identity headers are ignored; older pages
receive a generic compatibility identity until refreshed. Role restrictions and
the administrative password remain in place. Orders for an existing tab append
atomically so simultaneous devices cannot overwrite each other's items.

Checkout retry receipts still protect against duplicated sales and stock
changes. Saved mutations remain successful when the following screen refresh
fails. Financial writes go directly to D1 and never wait for a notification hub.

Migration 0006 removes the six revision-journal triggers so ordinary records and
stock updates no longer create auxiliary journal writes. It preserves all
business records, stock balances, and existing metadata. Legacy history and live
endpoints/classes are retained for compatibility, but the current UI does not
use them or publish mutation notifications. Existing dormant namespaces are not
deleted by deployment.

Full refresh intentionally reads more rows than the incremental implementation;
Cloudflare plan limits still apply. The application does not change the account
billing plan.

## Validation

Run npm.cmd test and npm.cmd run check in cloudflare/.

For a disposable local end-to-end test, use a separate local database:

    npx.cmd wrangler d1 migrations apply controle-adega --local --persist-to .wrangler/kitchen-flow-test
    npx.cmd wrangler dev --local --port 8788 --persist-to .wrangler/kitchen-flow-test --var ADMIN_PASSWORD:local-kitchen-test --var SESSION_SECRET:local-kitchen-secret

Then run node scripts/validate-kitchen-polling.mjs in another terminal. It checks
concurrent checkout retries, kitchen arrival, preparation, ready status at the
front, delivery, and complete snapshots. It refuses production URLs.

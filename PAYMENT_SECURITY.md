# Tune4Me payment security and migration — 2026-10-22

## Current status: NOT ready for paid-upgrade deployment

The planned promotional offer is **Tune4Me Plus – 25 Additional Saves for $1.99 USD**
(199 cents), paid once. Only the planned price changes: the free allowance stays 15,
each verified purchase adds up to 25 saves, and total capacity remains capped at 100.
There is no subscription. Existing paid access and saved songs must remain intact.

The owner previously confirmed the historical $3.00 USD offer (300 cents), with Stripe
Price ID `price_1TW6wbF6ZjaLgztEwIs2rwvk`. Keep that price and its payments as historical
records; do not relabel it as the $1.99 price or retroactively reprice past purchases.
The owner has now confirmed promotional Price ID `price_1UTYinF6ZjaLgztE8LiI83fl` for
**Tune4Me Plus – 25 Additional Saves, $1.99 USD, one-time**. Use this Price for future
secure checkout only after independently verifying its Stripe account, product, amount,
currency, type and live/test mode. These details are owner-confirmed; no authenticated
Stripe account verification has been performed by this documentation change. No account
setting, Stripe product, Price, coupon, refund or payment has been created or changed here.

The owner also confirms four previous purchases made for testing, each at $3.00 USD,
totaling $12.00, associated with the original offer. Preserve all four Stripe records,
their original Price ID, amounts, statuses and existing access. Their individual Session/
PaymentIntent IDs and Stripe live/test modes have not been supplied or verified. Do not
infer livemode from the words "test purchases" or from the Price ID format.

The original Payment Link is `https://buy.stripe.com/dRm6oHdbi0H0bi45x22Nq00`.
The owner reports it has been deactivated. Keep it deactivated; this has not been independently
checked against Stripe. Do not reactivate it or create a new active checkout link during setup.

Previously, success.html and handleUpgrade() granted capacity without payment evidence.
They now grant nothing and emit no sales events. The purchase button and upgrade prompts
explain temporary unavailability. The $1.99 text is advance promotional information, not
an active purchase offer. Checkout must remain disabled until purchaser authentication,
durable purchase records, signed-webhook fulfillment, migration and integration tests are
complete and a separate release is authorized. A confirmed Price ID alone cannot enable it.

Saved songs, playlists, preferences, and existing capacity remain on the same device. They
are unverified legacy access, not payment proof. Users can still edit their own browser
storage. A browser-only limit cannot enforce a commercial entitlement against a hostile user.
There is deliberately no fake database, cookie-only paid flag, success-URL grant, or mock
production webhook. Automatic grants stay blocked until the backend below is configured.

## Required setup (not provisioned by this change)

The inspected repository has no purchaser authentication or durable entitlement store. Local
environment names revealed no Stripe or database configuration. Production secrets and
Stripe settings could not be verified; absence locally does not prove absence in production.

Smallest combined option to evaluate: one Supabase project for Postgres and passwordless
email authentication, connected to Vercel. This supplies both missing capabilities with one
provider. No account, packages, schema, authentication flow, or paid service was created.
Free tier is suitable for development but can pause after inactivity; use an operationally
appropriate paid plan or another reliable Postgres/auth service before relying on webhooks.
Current options: https://vercel.com/marketplace/supabase and https://supabase.com/pricing.

In the correct Stripe account, open **Product catalogue → Tune4Me Plus – 25 Additional
Saves → Prices** and inspect the already-confirmed promotional Price
`price_1UTYinF6ZjaLgztE8LiI83fl`. Using authenticated server-side Stripe access, retrieve
that Price and its product and verify: intended account, product ID matching the existing
Tune4Me Plus product, amount=199, currency=usd, type=one_time and the intended livemode.
Independently verify original Price `price_1TW6wbF6ZjaLgztEwIs2rwvk` as 300 cents USD
under the same approved product. Do not replace either Price, create another offer, or
assume the supplied promotional ID belongs to live mode. If it belongs to test mode,
obtain and verify the existing live counterpart before any production checkout is enabled;
never invent a counterpart. Keep test and live credentials, Price allowlists and records
separate. No historical Price may be used as a silent promotional fallback.

Before implementation, complete these account/setup requirements without enabling checkout:

- Confirm the Stripe account ID, existing product ID and both Price/account/mode mappings.
  Obtain access to the four historical Session/PaymentIntent/charge records for read-only
  reconciliation. Preserve the original transactions; no refund, rebill, deletion or new
  payment is required merely because the promotional price changed.
- Provision the selected Supabase project with email authentication, production SMTP,
  approved site/redirect URLs, and durable purchase/entitlement tables. Restrict customers
  to their own permitted reads; only trusted backend operations can write paid grants.
  Preserve existing browser songs and allowances while the migration is being prepared.
- Configure server-only Stripe API access and Supabase privileged credentials in the correct
  Vercel environment. Keep live/test environments separate; never put secret values in chat,
  source control or browser code. Do not reuse OurFlow configuration without verification.
- After the webhook route exists, configure its Stripe event destination and environment-
  specific signing secret. Verify raw-body signatures, retry handling and durable commits
  before delivery can grant access. A browser callback or success URL remains insufficient.
- Confirm promotion timing, tax/discount treatment, the partial final expansion policy and
  purchaser recovery/refund rules. Complete the integration/migration tests below, then
  obtain separate launch authorization. Keep the old Payment Link and new checkout disabled.

## Required server implementation and data contract

1. Verify a purchaser's authenticated identity server-side. Use a secure, HttpOnly,
   Secure, SameSite cookie/session and CSRF/origin checks on purchase actions; never accept
   a user ID, email, local capacity, or client_reference_id as authentication.
2. Preserve the existing product, quantity=1 and one-time upgrade model. Once secure
   fulfillment is ready and separately released, create Checkout Sessions only on the
   server using promotional Price `price_1UTYinF6ZjaLgztE8LiI83fl` after its account/product/
   mode verification. Keep the old Payment Link disabled.
   Bind an authenticated purchaser before checkout. Store a random purchase-intent ID,
   purchaser ID, offer version, expected Price/product, expected amount/currency, mode,
   expiry and resulting Stripe Session ID. Snapshot these expectations; later promotional
   changes must not alter them. Set metadata on the server. Reject checkout at 100 and
   allow only one outstanding checkout per purchaser to avoid duplicate capped charges.
   At 90 only 10 spaces fit: disclose that capped result before charging, and obtain an
   explicit policy decision before releasing this final purchase. Never promise 25 usable
   spaces when fewer remain or silently change pricing/limits to hide the discrepancy.
3. Receive Stripe's signed raw-body webhook. Verify the signature and a short timestamp
   tolerance before parsing; enforce a body-size limit. Handle checkout.session.completed
   and checkout.session.async_payment_succeeded. A completed but unpaid session grants
   nothing; delayed payment can grant only after Stripe reports paid. Retrieve the Session
   and line items using server credentials. Require complete status, payment_status=paid,
   correct account/livemode, mode=payment, exact allowlisted Price/product, quantity=1,
   intent-snapshotted amount/currency and matching server-stored intent/session/purchaser.
   Validate new promotional purchases against 199 cents USD and verified Price
   `price_1UTYinF6ZjaLgztE8LiI83fl`; verify historical purchases using their original
   300-cent USD Price `price_1TW6wbF6ZjaLgztEwIs2rwvk` and recorded offer/mode. Historical
   migration uses verified ownership and historical evidence rather than pretending an
   old Payment Link session had a new server-created purchaser binding. Historical $3.00
   payments remain valid under their original verified offer. A payment
   of 199 cents alone does not prove that the right product was purchased. Do not
   trust redirect parameters, browser storage, email submitted by the browser, or metadata
   from a session that was not created/bound by the server. Define discounts explicitly;
   do not silently treat a free/no_payment_required session as a paid expansion.
4. Use a database transaction, row locking and UNIQUE constraints on Stripe Session ID
   and Stripe event ID. Insert a payment grant and update that purchaser's allowance
   atomically: min(100, previous verified allowance + 25). Bind each session permanently
   to one purchaser. Preserve original Price ID, paid amount/currency, offer version and
   grant size in immutable purchase records. Different event IDs for one session still
   grant only once, including events replayed across a promotion change. Duplicate,
   concurrent, replayed and out-of-order delivery must return the existing result without
   adding capacity. Do not mark an event handled or return success before a durable commit;
   database failures must be retryable. Do not use per-instance memory for this ledger.
5. Return only authenticated purchaser-specific allowance from an entitlement endpoint,
   with Cache-Control: no-store. The success page polls/reads this endpoint and reports
   pending when necessary; it never grants capacity. Persist saved data or enforce paid
   save operations server-side if hostile editing of local storage must be prevented.
   Browser saved songs may remain as an offline mirror; a signed allowance alone cannot
   make arbitrary browser code enforce a limit. Do not upload listening history merely
   to bind payment ownership. Choose the minimum authoritative saved-item metadata needed.
6. Count confirmed sales from the committed verified payment ledger, not browser analytics
   or webhook attempts. Distinguish transactions, granted capacity and revenue. Define
   refunds/disputes and reconciliation without deleting existing saved songs. Preserve
   each transaction's actual paid amount; do not report old $3.00 payments as $1.99 revenue.
   Keep test-mode transaction totals separate from real captured payments; neither browser
   reports nor the four purchases' unverified mode establishes $12.00 of live revenue.
   Historical `upgrade_completed` telemetry is not financial evidence.

Suggested tables: purchasers(auth_subject unique), purchase_intents(purchaser, expected
offer, stripe_session unique), payment_grants(stripe_session unique, purchaser, event,
verified payment fields), processed_events(stripe_event unique), entitlements(purchaser
unique, capacity <=100), and audited legacy_claims(stripe_session unique, purchaser,
verification source). Keep service credentials server-only and restrict database access.

Stripe references: https://docs.stripe.com/checkout/fulfillment and
https://docs.stripe.com/events/manage-webhook-endpoints.

## Existing purchaser migration — must precede enforcement

Keep current saved songs and capacity (up to the existing 100-song cap) available during a
published transition. Do not reset storage or retrospectively label all current users unpaid.
After identity is available, provide receipt recovery/claim support: reconcile historical
Stripe paid sessions against the historically approved product and Price, require verified control
of the purchaser's checkout email/account or reviewed equivalent proof, and bind each old
session to one purchaser in the same unique ledger. Never accept a screenshot, arbitrary
session ID, existing browser flag, or posted email alone as proof. Some historic payments
may lack sufficient ownership data: route those to manual support, not automatic denial.
Do not double-count a migrated payment as a new sale or grant it twice. Derive the paid
allowance from verified historical grants; do not add old payments again onto a browser's
existing allowance. Honor legitimate historical $3.00 purchases without requiring a new
$1.99 payment. Do not invalidate them because the current promotion is cheaper, and do not
automatically refund, rebill or change existing Stripe transactions. Preserve purchased
capacity and resolve discrepancies through reviewed support. Keep local music data intact. Offer an explicit recovery path for purchasers who already cleared storage.

Before switching to authoritative limits, reconcile verified historical capacity, explain
account recovery, and resolve discrepancies without reducing legitimate purchases or
deleting songs. Test the migration on copies and document rollback/support handling.

## Four historical purchases — preserve and reconcile

Retain all four original $3.00 purchase records and their $12.00 aggregate original amount.
Before migration, identify each unique Stripe Session/PaymentIntent and record its account,
product/Price, amount/currency, livemode, paid/refund/dispute status and verified purchaser.
Confirm they are four distinct purchases rather than four webhook deliveries of one payment.
Do not manufacture missing transaction IDs or mark them independently verified yet.

If Stripe reports livemode=false, keep the records and any fixture grants in the test ledger;
do not count the $12.00 as production revenue or automatically convert test payments into
production paid entitlements. If livemode=true, preserve and reconcile legitimate real paid
grants under the original terms, even if the owner calls them test purchases. Never
automatically remove existing local access based on this classification: keep the transition
protection and review any discrepancy through support. Refund/dispute state must be reviewed
without deleting songs. No past transaction is repriced at $1.99, deleted, refunded or rebilled
as part of this plan update, and no historical purchase is granted twice.

## Required payment acceptance tests after setup

Use Stripe test mode and a real durable test database: paid correct offer, pending/failed/
cancelled payment, wrong product/price/amount/currency/quantity/mode/account, forged or stale
signature, modified raw body, copied success URL, direct handleUpgrade call, replayed event,
different events for one Session, concurrent deliveries, another purchaser claiming a Session,
DB outage/retry, delayed payment, cap100, simultaneous checkout at the cap, refunds/disputes,
historical $3.00 receipt recovery, new $1.99 fulfillment, wrong Price IDs even when the
amount matches, and duplicate/late events across the price transition. Confirm historical
records/revenue and capacity are unchanged. Reconcile all four previous purchases and
their $12.00 original aggregate; prove test-mode records never become live sales or live
grants automatically, and legitimate real purchases retain their access. Test both supplied
Price IDs against wrong accounts/products/modes and reject mismatches before grants.
Current local tests prove the old client grant is closed; they do not prove an unconfigured
payment backend works.

## Promotion release gate

- Historical offer: 300 cents USD, Price `price_1TW6wbF6ZjaLgztEwIs2rwvk` (owner-confirmed).
- Promotional offer: 199 cents USD, Price `price_1UTYinF6ZjaLgztE8LiI83fl` (owner-confirmed;
  authenticated account/product/mode verification remains required before use).
- Preserve four original $3.00 purchases, $12.00 total, with original transaction identity
  and separate test/live classification. Do not reprice, duplicate or erase their grants.
- Benefits unchanged: initial 15 saves, up to 25 additional saves per verified grant, maximum 100.
- Promotion start/end and tax/discount treatment must be explicitly configured before release;
  no expiry, automatic renewal, coupon or new subscription is assumed by this plan.
- Keep purchaser-authentication, durable transaction/idempotency, verified webhooks and
  migration requirements. Configure production auth email delivery and least-privilege data access.
- Keep checkout disabled until those controls pass integration tests and launch is authorized.
  Do not use the historical Price as a fallback if promotional Price verification fails.

## R1 D1: Mobile Money prompts with a mock provider

First slice of Phase D. An accountant sends a Mobile Money payment prompt to a payer's phone from the student's page, then checks its status. A payment is recorded only when the provider confirms **exactly** the amount and currency requested. It goes through the same code as manual payments (receipt number, ledger credit, audit), in the transaction that marks the request successful.

### What's in it

- **Provider interface** (`src/server/mobile-money/provider.ts`) with one implementation: a stateless **mock** (test mode, no money moves). `MOBILE_MONEY_PROVIDER`: unset → mock in development, off in production; `mock` or `none` explicitly. Staff see "Test mode" on the dialog and on each request.
  - Mock numbers: ending 1111 decline, 2222 never answer, 3333 report GH₵1 less, 4444 not registered; any other number approves.
- **`mobile_money_requests` table** (migrations 0032/0033): forced RLS; one pending prompt per student; an idempotency key per form. Triggers keep the details (student, phone, amount, provider) immutable, set the provider reference and the outcome once, refuse DELETE/TRUNCATE, and check that a linked payment is Mobile Money for the same student and amount.
- **Rules:**
  - A reported amount or currency that differs from the request goes to _needs review_ and nothing is recorded; the accountant records what arrived by hand.
  - Checking twice, or at the same time, records one payment (row lock plus the payment's idempotency key).
  - Unanswered prompts expire locally after 30 minutes; a late confirmation is still recorded.
  - "Provider has no record" counts as failed only after 5 minutes.
- **Refactor:** `recordPayment`'s transaction body moved into `insertPayment` (`src/server/fees/payments.ts`), so every payment is written one way.
- **UI:** _Request Mobile Money_ on the student's Fees panel (Proprietor and Accountant, within their campus scope). Amount, guardian phone and network are pre-filled; the network is suggested from the prefix and can be changed for ported numbers. Recent requests show their status, _Check status_, and the receipt link once paid.

### How to test (5 minutes)

1. `npm run db:migrate`, then `npm run dev`, and sign in as `bursar@example.test` (two-step secret in the README).
2. Students → **Kojo Addo** → **Request Mobile Money**. The phone is pre-filled from the guardian and the network is AT. Click **Send prompt**.
3. Click **Check status**: the receipt opens, showing Mobile Money and a `MOCK.…` transaction ID. The balance drops.
4. Try `024 555 1111` (declined, nothing recorded), `024 555 3333` (held for review) and `024 555 4444` (error on the phone field; correct it and resubmit in the same dialog).
5. Sign in as `head@example.test`: there's no _Request Mobile Money_ button.

### Checks run (locally, Windows, PostgreSQL 16)

- Format, lint, typecheck: pass.
- Unit and integration: 294 of 295 pass. The new tests are 12 integration (`tests/integration/mobile-money.test.ts`) and 7 unit, all passing. The one failure is the existing intermittent phone-verification test. Cause: `notifications.test.ts` dispatches and clears other test files' outbox messages. It's unrelated to this PR and a separate fix.
- Playwright: **50 of 50 pass** on a fresh database with `--workers=2` (as on CI), including the 2 new Mobile Money specs. With 16 workers (32-core PC), 2–3 existing billing and payment specs race on shared seeded data, with or without this PR; that's a separate fix.

### Not in this slice (D2)

Provider callbacks (stored durably, verified, processed by the worker) and automatic status checks for pending prompts.

### Decisions needed before any real provider

1. **Whose account receives the money.** Recommendation: each school's own merchant or aggregator account, with credentials stored encrypted per school, so EduBridge never holds school funds (which would likely need Bank of Ghana licensing).
2. **Which provider to pilot.** An aggregator (e.g. Hubtel or Paystack) covers MTN, Telecel and AT in one integration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

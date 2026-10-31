# EduBridge — status and handoff (2026-10-31)

Written for the next engineer or coding agent. Read `CLAUDE.md` first (project rules), then this file,
then `docs/11-DEVELOPMENT-ROADMAP.md` (phases, decisions, assumptions) and `docs/03-DATABASE-DESIGN.md`
(tables). The founder's documents `00`, `01`, `02` and `13` are theirs; do not edit them.

## Where things stand

`main` is at `c1aac0e` and contains everything below. All PRs (#1–#19) are merged; none are open.

| Area             | State                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------- |
| R0 Foundation    | Done: auth, sessions, two-step verification, multi-tenancy with forced RLS, RBAC, audit, invites, campuses, notifications outbox (Brevo email, Arkesel SMS), platform admin |
| R1 Phase A       | Done: roles (Proprietor, Head teacher, Accountant), academic calendar, levels and classes, students, guardians and siblings |
| R1 Phase B       | Done: import students and guardians from Excel/CSV                                            |
| R1 Phase C, fees | Done: fee items and structures, append-only ledger, term billing, payments and receipts, voids, accounts list, daily payments, opening balances, one-off charges and credits, scholarships and discounts, families list, payment plans |
| Setup docs       | README covers Windows, macOS and Linux, with Docker (`compose.yaml`) or a native PostgreSQL   |

Last verified on this code (locally, PostgreSQL 16): format, lint, typecheck, **276** unit and integration
tests, **48** Playwright tests (three consecutive green runs). CI (`.github/workflows/ci.yml`) runs the same
on every PR and on pushes to `main`.

## What is next (approved plan, in order)

Keep PRs small, one slice each, with tests; summarise each with a 5-minute "how to test".

1. **Phase D: Mobile Money.** A provider-agnostic interface (MTN MoMo, Telecel Cash, AT Money) with a
   **mock provider first**. No real provider, credentials or paid service without founder approval. Must be
   idempotent, verify provider callbacks (signature and amount), and record a confirmed payment through the
   existing `recordPayment` path (`src/server/fees/payments.ts`) so receipts, ledger and audit stay one flow.
   Do not invent provider API details; leave real adapters until docs and sandbox access exist.
2. **Phase E: who owes what.** Owing list with filters (class, amount, overdue payment plans), one-click
   SMS reminders via the outbox, receipt and statement PDFs with `@react-pdf/renderer` and a font that renders
   the cedi sign (verify it), and free WhatsApp share links (no WhatsApp Business API in v1).
3. **Phase F: parent view.** SMS-code sign-in with a 30-day session; 7-day read-only balance links in
   reminder texts; rate limits per phone number and per school on code requests.
4. **Phase G: assessment and report cards.** Configurable grading with Ghana defaults (list GES assumptions);
   bulk report-card PDFs as a background job in batches, tested with 300–500 students.
5. **Phase H: attendance and offline** (explicit conflict handling). **I:** setup wizard, demo data,
   outcome dashboard, README "5-minute demo" per differentiator. **J:** export, billing records, feature flags.

## Founder decisions on record

- Merge PRs only with the founder's approval; never push to `main` directly. Work on a feature branch.
- Synthetic data only. No deployment, paid services or real payments without approval.
- Brevo (email) and Arkesel (SMS). Two-step verification on by default, configurable per school
  (default required for Proprietor and Accountant).
- PDFs: `@react-pdf/renderer`. Parent sign-in: SMS code (30-day session) plus 7-day balance links.
  WhatsApp: share links only for v1.
- Role labels: `owner` = Proprietor, `bursar` = Accountant, `headteacher` = Head teacher.

## Open questions for the founder

- How pilot schools apply **sibling discounts** (which child, which items). Today the accountant adds them
  per child from Fees → Families.
- Whether **only the Proprietor** should void receipts (current rule, a fraud control).
- Suggested fee items, GES level naming and grading defaults: listed as assumptions in the roadmap.
- Arkesel's sandbox and response format are unverified (their developer site was unreachable from here).

## How the code is organised

- `src/server/<module>/` — business logic, framework-free (ESLint enforces it). Every tenant query runs
  in `withTenant` (`src/server/db/context.ts`), which sets the RLS tenant for the transaction.
- `src/app/s/[school]/…` — pages and server actions per school; `src/components/ui/` — shared UI.
- `src/server/fees/` — `structure.ts` (fee items and structures), `ledger.ts` (billing, statements,
  reversals), `payments.ts` (payments, receipts, voids, accounts, daily totals), `opening-balances.ts`,
  `concessions.ts`, `payment-plans.ts`; pure, unit-tested planners: `resolve.ts`, `billing-plan.ts`,
  `discount-plan.ts`, `plan-schedule.ts`; `access.ts` (finance permissions and campus scope).
- `drizzle/` — migrations (generated, plus hand-written `*_rls.sql` for grants, policies and triggers).
  Every tenant table needs `ENABLE` + `FORCE ROW LEVEL SECURITY`; an integration test checks this.

## Rules the money code relies on (do not weaken)

- Money is integer **pesewas** (`bigint`); parse and format only through `src/lib/money.ts`.
- `ledger_entries`, `payments` and `payment_voids` are **append-only**: the app role has INSERT and SELECT
  only, and triggers refuse UPDATE, DELETE and TRUNCATE for every role. Corrections are reversals (exact
  negation, once per entry, checked by a trigger) or receipt voids.
- Automatic entries are idempotent through `billing_key` (unique per tenant and student). After a reversal,
  re-billing uses a numbered key (`…:2`); opening balances do the same.
- Receipt numbers come from `tenant_counters` inside the payment transaction (no gaps). Payment forms carry
  an idempotency key.
- School-wide finance changes (structures, billing, imports) need access to every campus; per-student work
  follows campus scope via `loadFinanceStudent`.

## Working locally

- Setup: README. Database URLs come from `.env.local` (scripts load it themselves on every OS).
- Seeded accounts use password `edubridge-dev-only`. `bursar@` and `platform@` need two-step codes from the
  dev-only secrets in the README. Demo school: `/s/kpone-ridge`.
- Gotchas met in this environment:
  - PostgreSQL may stop after a container restart: `service postgresql start`.
  - Playwright reuses a server already on port 3200; stop stray `next-server` processes before E2E runs,
    or tests hit an old build.
  - E2E tests share the seeded school and run in parallel: do not depend on page position or counts, and
    do not change a seeded student another spec reads. The accountant signs in once in the setup project
    (`playwright/.auth/accountant.json`) because parallel two-step sign-ins collide.
  - Seed scripts use one database connection: inside `db.transaction`, query with `tx`, never `db`.

## Known gaps

- Windows and Docker Desktop steps follow standard tooling but were not run on a Windows machine.
- One phone sign-in E2E run failed once and did not recur in four later full runs; cause not identified.
- Statements show discounts after all of a term's charges, not under each charge.

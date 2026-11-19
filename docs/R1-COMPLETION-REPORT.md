# R1 completion report — 2026-11-09

For the founder, before R3 starts. Requirement-by-requirement status is in the one-page
[traceability matrix](RTM.md); decisions and design notes are in the [roadmap](11-DEVELOPMENT-ROADMAP.md);
running it in production is in [deployment and operations](DEPLOYMENT-AND-OPERATIONS.md).

## 1. Verdict

R1 is complete against `01-PRODUCT-REQUIREMENTS.md` §5: every R1 requirement is built and covered by
automated tests, with five recorded limitations (§4) and two items that need your decision before
production use (§5). Nothing below claims more than was run: results are in §3.

## 2. What was audited and finished

The audit compared `01` §5, the roadmap, the code and the pilot feedback. Built to close R1:

| Area | Delivered |
| --- | --- |
| Finance controls | Closing the books (enforced by the database, so no path can post into a closed period); refunds with a two-person rule; duplicate payment-reference warning; optional fee items; discount approval thresholds for the Proprietor; reports by class, level and campus on screen and as CSV; payment evidence files; statements and family statements for any date range; daily Mobile Money reconciliation with differences for the Accountant (never corrected silently) |
| Parents | Pay by Mobile Money from the parent view (test mode), with each attempt's status; receipt links in the receipt SMS; family statements; announcement SMS opt-out (essential messages always sent); invitations by SMS; the parent view offline with an "as of" time, cleared at sign-out |
| Students and identity | Photos; private documents and medical information (every view recorded); guardian roles (fee payer, emergency contact, collection, messages); statuses with reasons (suspended, withdrawn, transferred, graduated); preferred names; admission number format; search by guardian phone; school logo and colour on the app, parent view, receipts and statements |
| Messages | SMS when fees are billed; receipts and reminders go to the guardian who pays the fees |
| Overview | Campus filter, using exactly the scope of a member of that campus, so figures match the reports |
| Your decisions of 2026-11-09 | Assistant configured by platform staff and enabled per school (names pseudonymised unless allowed); platform-managed signing keys with rotation (earlier records still verify); balance shown on transfers and record release, the school decides; offline provisional receipts at the Proprietor's choice; Paystack live payments still off |
| Africa-wide readiness | Country profiles for 11 countries; each school's currency on every screen, export, message and PDF; phone numbers in each country's own form; holidays by country; starter templates for levels, subjects, grades and assessment parts (Ghana, Kenya, Nigeria, francophone, international), chosen per school; Mobile Money only where the provider collects the school's currency |
| Teaching models | Each school chooses class teachers (enter every mark) or subject teachers (one teacher per subject per class, across as many classes as they teach); registers, remarks and report cards stay with the class teacher |
| Operations | `npm run keys:rotate` to rotate the master encryption key safely; deployment and operations guide |

## 3. Verification (run on 2026-11-09, PostgreSQL 16, Node 22)

| Check | Result |
| --- | --- |
| Format (Prettier), type check (strict TypeScript), lint (ESLint) | Passed |
| Unit and integration tests (`vitest`) | 544 passed and 3 skipped (the Paystack test-mode file, which runs only with `PAYSTACK_TEST_SECRET_KEY` exported) in 82 files, 0 failed (corrected 2026-11-10) |
| End-to-end (Playwright, production build, freshly migrated and seeded database) | 91 passed, 0 failed (desktop and mobile projects) |
| A school in Kenya end to end (shillings, Kenyan numbers, M-Pesa via the test provider, receipts, reconciliation) | Passed (`tests/integration/kenya-school.test.ts`) |
| Migrations 0065–0072 | Applied to the development database and to a fresh end-to-end database |

## 4. Defects found and fixed during completion

| Defect | Effect before the fix | Fix |
| --- | --- | --- |
| A client-module constant used by the server-rendered student page | The student page failed in production builds (development hid it); it caused most of the 18 failures in the first end-to-end run (the others were tests needing updates for deliberate wording and flow changes) | Moved to a shared module; full end-to-end run green |
| Mobile Money payer numbers limited to Ghana by a database check | Any non-Ghana school's prompt was refused | Migration 0072: any E.164 number; the service checks the school's country |
| Platform SMS price (cedis) applied to schools in other currencies | Wrong SMS charges for non-GHS schools | The platform price applies to GHS schools only; others need their own |
| Typed amounts in offline payments converted with floating point | Rounding risk on provisional receipts | Parsed digit by digit in the school's currency |
| Balance looked up in a subquery that bound to the wrong table | "Fees billed" SMS showed a balance of 0 | Separate grouped query; covered by a test |
| CSV exports and chart axes assumed two decimals and "GH₵" | Wrong figures for currencies without decimals (UGX, XOF) | Currency-aware exports and axes |
| Guardian, import, contact and parent sign-in numbers read only in Ghanaian form | Staff outside Ghana had to type country codes | Numbers read in the school's country; parent sign-in accepts a national number that belongs to exactly one country |

## 5. Decisions pending (yours)

1. **Transfer consent: data-protection and privacy review.** Built and tested; must be reviewed (Act 843 and
   cross-border transfer between schools) before it is used with real families.
2. **Paystack go-live.** Built and tested in test mode with subaccounts per school. Needs: your approval,
   Paystack business verification, each school's subaccount, and legal confirmation that funds settle to
   schools (D-07). Steps are in the deployment guide §8.
3. Hosting provider and region (D-12), and paid services (error tracking, SMS and email accounts, the
   assistant's Anthropic usage): none activated.
4. Non-Ghana templates, holiday lists and Mobile Money networks are assumptions to verify with schools in each
   country before selling there.

## 6. Remaining limitations (known, not defects)

- FIN-04 and FIN-08: a balance-forward ledger instead of separate invoice documents with per-invoice allocation
  (recorded deviation; statements, ageing and reports reconcile from the same ledger).
- Parents have no email channel in R1; their finance messages are SMS.
- Mobile Money collects GHS only (Paystack); other currencies need a second provider (R3).
- "Applicant" status belongs to admissions (R3, since built); subject-period attendance and timetables were R2
  items, built when R2 was completed on 2026-11-10.
- Mobile Money for parents and staff shows "test mode" until live payments are approved.

## 7. Blocked

Nothing in R1 is blocked by engineering. Go-live is blocked only by the decisions in §5.

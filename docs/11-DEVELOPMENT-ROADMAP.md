# 11 — Development Roadmap

|         |                                                                                 |
| ------- | ------------------------------------------------------------------------------- |
| Related | `01-PRODUCT-REQUIREMENTS.md` §4 (releases R0–R5), `02-SOFTWARE-ARCHITECTURE.md` |

Small, verified milestones. Each ends with passing tests, type checks, lint and a reviewed pull request.

## R0 — Foundation

| #   | Milestone                                                                                                                            | Requirements                                             | Status              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------- |
| 1   | Project foundation, design system, app shell, PostgreSQL + forced RLS, sessions, RBAC, audit log, CI                                 | TEN-02, IAM-04, IAM-05 (no campus yet), IAM-08 (partial) | Done (#1) |
| 2   | Platform admin: create school (TEN-01), entitlements (TEN-05); campuses (TEN-03) and campus-scoped permissions                       | TEN-01, TEN-03, TEN-05                                   | Done (PR #2). Campus scope is stored and resolved; assigning it in the UI comes with milestone 3 |
| 3   | Member management: invite, assign roles, deactivate with immediate session revocation, audit log view                                | IAM-07, IAM-08                                           | Done (PR #3). Suspension takes effect on the next request (no session revocation needed: access is re-checked per request) |
| 4   | Account security: password reset (IAM-03), TOTP MFA required for owner/bursar/platform admin (IAM-06), phone-number sign-in (IAM-01) | IAM-01, IAM-03, IAM-06                                   | Done (#4, #5, #6): two-step verification as a per-school policy, password reset by email or SMS, phone numbers verified by SMS and phone sign-in |
| 5   | Background jobs (pg-boss + outbox), structured logging, error monitoring hooks                                                       | `02` §8, §14                                             | Partly built (#5): notification outbox, after-response dispatch and a polling worker. pg-boss when general jobs are needed |

SMS OTP (IAM-02) and email delivery need a provider; they wait for approval of the provider and cost.

## Milestone 1 — implementation notes against `02`

Built as `02` describes: Drizzle with reviewed SQL migrations; tenant = school; shared schema with
`tenant_id`, RLS **enabled and forced**, a non-owner app role without `BYPASSRLS`; tenant context set
with transaction-local `set_config` in `withTenant`; tenant resolved server-side from the URL hint plus
an active membership; global `users`, roles per membership; append-only `audit_events` written in the
same transaction as the change; Radix + Lucide + Tailwind tokens; real-PostgreSQL tests; staff routes
under `/s/{school}`; `en-GH` formatting.

Differences from `02` (D-09 is decided; the rest are still open):

| Topic               | `02` says                                                                                    | Milestone 1 does                                                                                                                                       | Why / cost to change                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-09 process layout | Separate Fastify `api` + `worker`; monorepo | **Decided:** single Next.js app on a long-running Node server, with a worker process later, both using `src/server` | See [ADR 0001](adr/0001-process-layout.md) |
| Password hashing    | Argon2id                                                                                     | scrypt (Node built-in, memory-hard, OWASP parameters). Hash format is versioned                                                                        | Can switch to Argon2id with re-hash on next sign-in; Node 24 has it built in, or a native package on Node 22                                        |
| Primary keys        | UUIDv7                                                                                       | UUIDv4 (`gen_random_uuid()`)                                                                                                                           | PostgreSQL 16 has no native v7. Changing the defaults later is a one-line migration per table                                                       |
| Parent access       | Guardians per tenant, linked to global users via `guardian_portal_link`; parent home at `/p` | Phase F: the parent is a verified phone number with its own session (`parent_sessions`), not a `users` row; children are every student linked to a guardian with that number at an active school, worked out per request (D-04: OTP to the number on file). The `parent` and `student` membership roles stay unused | No passwords or emails for parents, and no linking step that could go stale. A staff member who is also a parent signs in to `/p` separately. Adding a `users` link later is additive |
| Composite FKs       | `(tenant_id, x_id)` between tenant tables                                                    | Not needed yet: current tenant tables only reference global tables                                                                                     | Applies from the first tenant-to-tenant reference                                                                                                   |
| Offline (PWA)       | Serwist or Workbox service worker; IndexedDB attendance queue                                 | Phase H: a small hand-written service worker (`public/sw.js`, about 100 lines) that caches only register pages and built assets; IndexedDB queue as planned. Browsers sync through a server action (built-in CSRF protection) rather than `/api/v1`, whose cookie-authenticated writes are refused | No dependency for a narrow job. Move to Serwist if offline grows beyond registers (e.g. the parent PWA cache, PRT-07) |
| Testcontainers      | Ephemeral Postgres per test run                                                              | Disposable `edubridge_test` database on a local or CI Postgres service                                                                                 | Same isolation guarantee; no Docker needed                                                                                                          |

## R1 — Competitive wedge (approved plan, 2026-10-31)

| Phase | Scope | Status |
| --- | --- | --- |
| A | Roles (Proprietor, Head teacher, Accountant), calendar, levels and classes, students, guardians | Done (#7–#11) |
| B | Import students, classes this term and guardians from Excel/CSV | Done (#12) |
| C | Fee structures, ledger, part payments, cash/bank entry, arrears, receipts | Done (#13–#17, #19) |
| D | Mobile Money behind a provider-agnostic interface (mock first) | Built with the mock provider: D1 staff prompts and status checks; D2 signed callbacks, worker status checks, Fees → Mobile Money list and review of held payments. A real provider waits for the decisions below |
| E | Who-owes-what, reminders, receipt/statement PDFs, WhatsApp share links | Built: Fees → Owing, SMS reminders, receipt and statement PDFs, WhatsApp links |
| F | Parent view: SMS-code sign-in, balances | Built: `/p` sign-in by SMS code (30-day session), children at every school with balances, plan, receipts and statement; 7-day balance links in reminders; blocking per guardian |
| G | Assessment and bulk report cards | Built: subjects per level, assessment parts per term, grade bands per stage (Ghana defaults), score sheets, report cards with remarks, head teacher approval, bulk PDF printing in the background, report cards in the parent view |
| H | Attendance and offline sync | Built: daily class registers (present, late, absent, excused, with reasons) that open and save without a connection and sync when back, conflicts shown for a person to decide, change history; attendance on report cards and in the parent view |
| I | Setup wizard, demo data, outcome dashboard | Built: setup guide worked out from the school's records, a role-specific Overview (fees, arrears ageing, reminders' effect, attendance, report cards, enrolment) whose figures match the reports they link to, `npm run demo:school`, and README 5-minute demos |
| J | Data export, billing records, feature flags | Built: plan features and limits checked on the server, SMS usage records, subscription records and EduBridge invoices to schools, and CSV export of a school's records |
| K | Moving students into the next term and year (ACS-04) | Built: carry classes over within a year, promote up a level into a new year with the last level graduating, keep students back, preview before saving, undo until anything is recorded for the new term |
| L | School holidays, absence SMS, SMS pricing and overdue handling (founder decisions, 2026-11-06) | Built: holidays stop registers (with suggested Ghana public holidays), absence SMS after configurable days in a row or a term total, SMS price per platform and per school, 3-day grace then SMS pause for overdue EduBridge invoices |
| N | School choices (founder decisions, 2026-11-06) | Built: sibling discount rule, Proprietor decides whether Accountants void receipts, shared sign-in codes split between schools, overview collection rate and attendance follow-up configurable |
| M | Paystack (D-06: chosen 2026-11-06) | Built and tested against Paystack's test mode: Mobile Money prompts, verification before any receipt, signed webhooks at one address, a subaccount per school. Live payments wait for approval |
| O | Messages to families | Built: payment receipt SMS and automatic fee reminders (each school turns them on), announcements to the school, a campus, a level or a class (parent view, optionally SMS), each family's message history, school contact details in the parent view |
| P | Support access (PLT-02, D-08; founder decisions 2026-11-06) | Built: the Proprietor allows EduBridge support in for 1 hour to 7 days and can end it at any time; support can make changes; every page support opens and every change it makes is recorded and shown to the Proprietor |
| Q | API foundation (founder instruction, 2026-11-07) | Built: `/api/v1` over the existing services (students, classes, registers, score sheets, sync, transfers, insights, assistant), device-token sign-in with the second step, revocable devices under Account, Devices |
| R | Offline sync protocol | Built: operations recorded once in the same transaction as their effects, conflicts never overwritten, change feed by triggers; offline score sheets and offline student registration on the web |
| S | Transfer Passport | Built: portable learner identity, signed and verifiable learner records, consent-based transfers between schools on EduBridge, export and import for schools elsewhere, public verification |
| T | School insights | Built: term-by-term enrolment, results, attendance and money; falling results and students who may need support; results by level and subject; absence and lateness; money by level and plan instalments due; registers and marks outstanding |
| U | School assistant (AI) | Built behind a switch: read-only, permission-aware answers from the school's records, every question audited; off until the paid service is approved |
| V | Platform integrations (founder decisions, 2026-11-09) | Built: Admin, Integrations: the assistant's Anthropic key and switch, set by platform staff and stored encrypted; each Proprietor decides whether the school uses it and whether names are shared (otherwise pseudonymised). Transfer Passport signing keys generated, stored encrypted and rotated there; retired keys keep verifying earlier records |
| W | R1 completion: finance controls | Built: closing the books (database-enforced period lock), refunds with a two-person rule, duplicate-reference warning, optional fee items, discount approval thresholds, reports by class, level and campus (screen and CSV), payment evidence, statements and family statements for a date range, daily Mobile Money reconciliation, offline provisional receipts (Proprietor's choice) |
| X | R1 completion: profiles, identity and families | Built: school logo and accent colour (staff app, parent view, receipts, statements), student photos, private documents, medical information (views recorded), guardian roles, statuses with reasons, admission number format, search by guardian phone, parent-view invitations, announcement SMS opt-out, receipt links in SMS, fees-billed SMS, parent payments by Mobile Money (test mode), parent view offline |
| Y | Africa-wide readiness (founder instruction, 2026-11-09) | Built: country profiles (11 countries), currency per school on every screen, message, export and PDF, phone numbers in each country's form, holiday suggestions by country, starter templates for levels, subjects, grades and assessment parts (Ghana, Kenya, Nigeria, francophone, international), Mobile Money by country and currency |
| Z | Teaching by class or by subject (founder instruction, 2026-11-09) | Built: each school chooses; subject teachers are given a subject in any number of classes (one teacher per subject per class), enter only those marks, and see only those sheets; class teachers keep registers, remarks and report cards |

Import limitations: names must be in separate first-name and surname columns; fee balances were added in phase C; importing past marks is not built yet.

Fees: money is integer pesewas (`bigint`), never floating point. Structures are per term and level, with optional class overrides (0 exempts a class). Only the Proprietor and Accountant change fees, and only with access to every campus; the Head teacher has read-only access. The ledger is append-only (database grants and triggers); corrections are reversals that exactly negate an entry, once. Billing is idempotent per student, term and item, never changes existing charges, and lists charges that differ from the structure; to correct one, reverse it and bill again. Payments are insert-only, with gapless per-school receipt numbers and an idempotency key per form; a receipt is voided (never edited) and its credit reversed. Payments credit the balance as a whole, not individual fee items. Opening balances (one live per student; reverse to re-enter) come from a spreadsheet or per student, dated before the term by default. Scholarships and discounts belong to a student (a percentage of one or every item, or a fixed amount off one item); billing adds them as separate discount entries, never more than the charge. Sibling discounts are added per child from the families list, because schools differ on which child and items qualify. Payment plans spread an amount over 2–12 equal instalments (remainder on the last); payments recorded after the plan is agreed are applied in due order, and the ledger is unchanged. Assumptions to verify: how pilot schools apply sibling discounts; only the Proprietor may void receipts; the suggested fee items, and that the Administrator role has no finance access by default (a school can add the Accountant role to that person).

Mobile Money (D1): an accountant sends a payment prompt to a payer's phone from the student's page and checks its status. A payment is recorded (receipt, ledger, audit, through the same code as manual payments) only after the provider confirms it for exactly the amount and currency requested; a different amount is held for review and recorded by hand. Requests are idempotent per form, one pending per student, and checking twice or at the same time records one payment (row lock plus the payment idempotency key). A prompt unanswered after 30 minutes expires locally, but a late confirmation is still recorded. Providers implement `src/server/mobile-money/provider.ts`; only the mock exists (`MOBILE_MONEY_PROVIDER`, default mock outside production and off in production; shown to staff as test mode). Mobile Money (D2): providers call back to `/api/v1/mobile-money/callbacks/{provider}/{school}` (public; the provider's signature is verified before anything is stored). Callbacks are stored in `mobile_money_callbacks` (no raw body, only its SHA-256 so retries count once), acknowledged, and processed after the response; the worker (`npm run worker`) processes any left over and checks waiting prompts itself every minute (expired ones every 15 minutes, for 24 hours), so a lost callback only delays a receipt. A callback only names the request: the outcome always comes from asking the provider. Outcomes recorded this way have no user (the receipt shows no recorder; audit actor is empty). The school is in the callback URL because each school should collect into its own account; a callback addressed to the wrong school finds no request and changes nothing. Payments held for review are listed under Fees → Mobile Money and closed once with a note (`reviewed_at`, set once by a trigger). The mock posts its own signed callbacks (`MOBILE_MONEY_MOCK_CALLBACKS`, `MOBILE_MONEY_MOCK_CALLBACK_DELAY_MS`, `MOBILE_MONEY_MOCK_SECRET`). The worker visits every active school each cycle (fine for the pilot; index or queue it when schools number in the hundreds). Decisions to make before a real provider: whether each school collects into its own merchant account (credentials stored per school, encrypted) or through an aggregator, so EduBridge never holds school money; and which provider or aggregator to pilot.

Who owes what (E): Fees → Owing lists every student with a balance, largest first, with the contact to reach (the primary guardian, or another guardian with a phone when the primary has none), last payment, last reminder and payment-plan arrears; filters by class, minimum amount and families behind on a plan; campus scope applies. The list is computed in memory after one query (fine for pilot schools of a few thousand students; move plan arrears into SQL if lists grow past that). SMS reminders (`fees.remind`: Proprietor and Accountant) are queued in the outbox with a `fee_reminders` record (insert-only, one per student per school day by a unique index), at most 200 per send, after a confirmation showing the message. The SMS carries the child's first name and the balance at the time of sending (founder decision, 2026-11-04), written "GHS 1,120.00" in plain characters so it stays one 160-character SMS for typical school names (the cedi sign would force Unicode SMS at 70 characters); very long names and amounts can take two SMS. WhatsApp links (`wa.me`) open the member's own WhatsApp with a message that includes the balance, which they see and can edit before sending; nothing is sent by EduBridge. Receipt (A5) and statement (A4, paginated) PDFs use `@react-pdf/renderer` with IBM Plex Sans; the basic-Latin font file has no cedi sign, so styles fall back to the extended-Latin file (checked by rendering: without it "GH₵" prints as "GHµ").

Parent view (F): parents sign in at `/p/login` with a 6-digit SMS code (10 minutes, 5 tries) sent only to a number a school has on file for a guardian who is not blocked; unknown numbers get the same answer and no SMS. Code requests are limited per number (3 in 15 minutes, 10 a day), per network address (30 an hour, generous because mobile networks share addresses) and per school (300 SMS codes an hour). The session (own cookie, 30 days, renewed while in use) holds only the verified number. Every request works out the children from the guardian records, school by school in separate tenant transactions; the only cross-school read is a row-level-security policy that shows guardian rows with exactly the signed-in number (`app.parent_phone`). So a new number, an unlinked guardian or a block applies on the next page. Parents see each child's balance, last payment, payment plan, receipts (PDF) and statement (screen and PDF), read through the same functions as the staff screens (tested equal). Fee reminders carry a 7-day read-only balance link (`/b/{token}`, 128-bit token, hash stored) that works only while the guardian still has that number, is linked to the child and is not blocked; it shows the school, first name, live balance and plan position. The Proprietor, Head teacher and Administrator (`parents.access.manage`) block or allow a guardian from the student page (audited). The worker purges expired parent sessions and old codes hourly. Not yet: paying from the parent view (needs a real provider), notification preferences, and the offline PWA cache (PRT-07). Parent sign-in codes are paid for by the school, like reminders (founder decision, 2026-11-05); the per-school hourly limit protects that spend. Each code records the schools that had the number (`parent_sign_in_codes.tenant_ids`), so SMS billing records (phase J) can charge it; a number on file at several schools will need a rule (e.g. split, or the school of the child most recently viewed).

Assessment and report cards (G): Assessment (`assessment.enter`) is for the Proprietor, Head teacher, Administrator and Teacher; teachers reach only classes they are class teacher of, and campus scope applies. Setup (`academics.manage`) chooses each level's subjects, how each term is assessed (parts with weights adding up to 100%, each entered out of its own maximum) and each stage's grade bands. Marks are integer tenths; a subject total is each part scaled to its weight, out of 100, rounded half up to a whole mark, and graded from that mark; a subject without every part has no total ("Not graded"). Averages and positions count only complete students; ties share a position (1, 2, 2, 4). Score sheets save only changed marks, and only if each is still what the sheet showed, so two people never silently overwrite each other; every change is audited (old and new mark). Class teachers write attitude, conduct, interest, attendance (by hand until phase H) and their remark; the Proprietor and Head teacher (`reports.publish`) write the head teacher's remark and publish, per student or per class. Publishing freezes the whole card (results, positions, bands, names, next term's start date) and locks the student's marks (database trigger); a published card is never edited, only withdrawn to draft with an audited reason. Families see published cards in the parent view (screen and PDF). Printing makes one A4 PDF per class, a page per student, in the background (started after the response, picked up by the worker if interrupted; one worker per run by a lease); 400 report cards across 10 classes printed in 10 seconds in the integration test. Drafts can be downloaded as a PDF marked "Draft, not approved". Assumptions to verify with pilot schools: subjects follow the GES/NaCCA Standards-Based Curriculum (KG learning areas; primary lists the Basic 4–6 subjects, so lower primary removes French and History per level) and the Common Core Programme for JHS; the default parts are class score 50% (out of 50) and exam 50% (out of 100), though many schools use 30/70 or 40/60; KG and primary grade with NaCCA's proficiency levels (A 80+, P 75–79, AP 70–74, D 65–69, B below 65) and JHS with the 1–9 BECE-style scale (1 from 90 down to 9 below 35, boundaries vary by school); class positions are off by default because GES guidance discourages ranking pupils. Not yet: subject teachers (only class teachers enter marks), importing marks from a spreadsheet, attendance from registers (phase H), report-card templates for other curricula (Cambridge, IB, American), school logos and signatures, BECE aggregates, promotion decisions, and SMS to families when a report card is published.

Attendance (H): one register per class per school day (`attendance.take`: Proprietor, Head teacher, Administrator, and Teachers for classes they are class teacher of; campus scope applies). Each student is present, late, absent or excused (absences can carry a short reason); late counts as attending. Registers can be taken for today or earlier within a term; teachers can correct the last 7 days, academic leads any day. Every mark has a version; a change names the version it was made from and applies only if the mark is still at it, otherwise it comes back as a conflict showing both marks, who made the other and when, and the person chooses ("Keep mine" is then recorded as such). Last-write-wins is never used (`13` T-05). Every change is kept in an insert-only history (before, after, who, how it arrived: online, offline or kept after a conflict, and when it was recorded on the device); versions can only step by one (trigger). Offline: the service worker keeps register pages (network first) and built assets; opening Attendance while connected saves today's registers for the user's classes, and each register refreshes its offline copy after every save. Marks made without a connection are kept in IndexedDB (student ids and statuses only, per user) and sent automatically when the connection returns, oldest first; a retried sync applies nothing twice. Sign-out clears saved pages and stored conflicts (which carry names) but keeps unsent marks for their owner. The service worker is registered only in production builds. Report cards take days present and days open from the registers unless figures are typed in; parents see this term's attendance and latest days away (not reasons). Not yet: subject (lesson) attendance, early departures, SMS alerts to families for absences (an SMS cost decision, like reminders), attendance trends and school-wide reports, and a school calendar of holidays (weekends and holidays are allowed but not blocked).

Setup, overview and demo (I): the setup guide (`/s/{school}/setup`, for the Proprietor, Head teacher and Administrator) has seven steps: calendar with a current term, levels and classes, staff and class teachers, students in classes, guardians' phone numbers, fees set and billed, and subjects. Each step's state comes from the records every time (nothing is ticked by hand, so it cannot drift), each says who can do it, and the Overview shows the next step until all are done. The Overview differs by role. Finance staff (`fees.view`) see, for the chosen term: billed (charges less discounts, leaving out reversed ones; also shown on the fee structure page), collected (receipts not voided, from the term's first day to today; opens Fees, Payments, which now also shows totals for any period of up to a year), the collection rate (collected ÷ (owed when the term began + billed)), families who paid within 7 days of an SMS reminder, collections per week and by method; and what is owed today (equal to Fees, Owing) by age: 0–30, 31–60, 61–90 and over 90 days, with credits settling the oldest charges first and reversed pairs left out. Academic leads see attendance this term (late counts as attending), today's registers, attendance by class, students below 80% once on 5 or more registers, and marks and report cards by class. Enrolment (Proprietor, Head teacher, Administrator, Accountant) is by level, by campus when there are several, and by sex. Class teachers see their classes today: register status and marks progress. Campus scope applies throughout; money figures follow the same scope as the fee reports. Charts are drawn with plain HTML and CSS (no chart library), link to the underlying report, and have a table view. `npm run demo:school` creates a demonstration school (`tenants.is_demo`) with about 300 students and a term of payments, reminders, registers, marks and one class's published report cards, through the same service functions as the app (only the school, staff accounts, admission dates and past reminder dates are written directly). Demo schools are labelled on every page, record reminders without queuing an SMS, are left out of parent sign-in and balance links, and have two-step verification off; the app role cannot set `is_demo`. Assumptions to verify: the collection-rate definition and the 80% attendance threshold; Ghana's term dates and public holidays used by the demo. Not yet: finance figures by campus (they follow the user's campus scope, like the fee reports), revenue and enrolment trends across terms, new admissions and withdrawals (admission dates from imports are the import day, so a count would mislead), academic performance by subject, staff activity, and a plan (entitlements) row for demo schools, which only a platform administrator can write; when a real Mobile Money provider is added, demo schools must stay on the mock.

Plans, billing and export (J): each school's plan (`tenant_entitlements`, edited only by platform staff on the school's admin page) says which modules it includes: attendance, assessment and report cards, the parent view, SMS fee reminders and Mobile Money (students, classes, fees, payments and receipts are always included; no packages are built in, as the bible asks). Every permission check goes through `allowed` / `assertAllowed`, which add the plan to the role, so a module left out is refused by the server with a clear message, disappears from navigation and returns "not found" for its pages. Turning a module off never touches its data: published report cards stay in the parent view, prompts already sent are still settled, and everything can still be exported. Without the parent view, families cannot sign in to that school and reminders carry no balance link. Limits: active students (checked when adding, importing or reactivating, under a per-school lock) and SMS per month (reminders beyond it are skipped and reported). A school without a plan row gets every module, so schools made outside onboarding (tests, demo schools) behave as before. Billing records (PLT-03, manual in R1): the subscription (trial, active, payment overdue, grace; billed per term, year or month; price, trial end, paid until; staff notes), shown to the school under Settings, Plan; `sms_usage` records every SMS a school pays for in the same transaction that queues it, so usage survives the hourly purge of sign-in codes; undelivered messages are not charged. EduBridge invoices are issued from the school's admin page (lines prefilled from the plan price and last month's SMS, amounts worked out on the server), marked paid with a reference or voided with a reason, once; the school sees them under Settings, Plan, and Admin, Billing shows every school's position for a month (demo schools listed but left out of totals). Every change is audited in the school's log. Data export (Settings, Data export): students, guardians, classes by term, fee accounts, payments and receipts, balances, attendance, marks and the audit log as CSV (UTF-8 with a byte-order mark, amounts as plain decimals, dates as year-month-day, text that a spreadsheet would run as a formula neutralised); everything for the Proprietor, fee records also for the Accountant; whole-school access required; every download audited. Not yet: invoice PDFs and emailing invoices, online payment of EduBridge invoices, automatic status changes at the end of a trial or paid period, plan presets, SMS segment counting (each message counts as one), a ZIP of all files at once, and exports for staff limited to some campuses.

Moving between terms (K): a school's classes are permanent, and students are placed in a class per term, so a new term starts with nobody in classes. Classes, Move to another term (`academics.manage`, whole-school access) moves everyone from one term into a later one in a single step. Within the same academic year each class carries over; into a new year each class goes up to the next level's class with the same stream at the same campus ("Basic 4A" to "Basic 5A"; the only class of the next level if names differ), and the last level graduates (student status set to graduated). Every destination can be changed (another class, graduate, or don't move) and students can be kept back (repeating or leaving) to place by hand. The page shows the counts before anything is saved; the move is one transaction under a per-school lock, never places a student twice (students already placed in the new term are left as they are), and is audited. A move (`term_moves`, with the placements it made) can be undone, once, until fees, registers, marks or report cards are recorded for its students in the new term; undoing removes its placements and makes graduated students active again (within the student limit). Earlier terms' classes are history and never change. The overview prompts the people who can move students when the current term has nobody in classes but the term before it had. Not yet: per-student destinations other than keeping back, promotion rules by results, and moving only one campus.

Founder decisions (2026-11-06): Paystack is the payment provider (D-06). SMS and subscription prices are configurable: subscription price per school; SMS price set for the platform (Admin, Billing) with an optional price per school. When an EduBridge invoice is overdue the school gets a 3-day grace period (configurable on Admin, Billing), then school-initiated SMS pause. No absence SMS by default; a school can turn them on for a number of school days absent in a row and/or a total in a term (both configurable). Build a school holiday calendar.

Holidays, absence SMS and pricing (L): school holidays (Settings, Calendar; `academics.manage`) are date ranges within terms; no register can be taken on them (also when synced from a device that was offline), and the overview does not count today's registers on a holiday. Suggestions list Ghana's public holidays for a school year from Act 601 as amended in 2025 (Act 1142: Republic Day on 1 July restored, Founders' Day on 21 September, 4 August no longer a holiday), with Easter and Farmers' Day (first Friday of December) worked out; Eid al-Fitr, Shaqq Day and Eid al-Adha follow the moon and are added by the school once announced. Assumption to verify each year against the Ministry of the Interior's list. Absence SMS (Settings, Attendance; `attendance.manage`: Proprietor, Head teacher, Administrator; part of the attendance module) are off until a school turns them on, with "after N school days absent in a row" (default suggestion 3) and/or "after N days absent in a term" (default suggestion 10). Only "absent" counts (excused does not). They are checked when a register is saved, in the same transaction, and go to the primary contact only when that register is the student's latest and is from the last two days (correcting old registers never sends anything); each family gets one SMS per run of absences and one for the term total (`absence_alerts`, insert-only, unique per student, term, kind and run). The message says how many school days, never the reasons. They count towards the plan's monthly SMS limit and usage (charged like reminders); demo schools record but never send. Overdue handling: worked out on each request from the school's unpaid invoices (never stored): from the day after an invoice's due date the school is in a grace period (default 3 days, a banner to the Proprietor, Administrator, Head teacher and Accountant says when SMS will pause), then fee reminders are refused and absence SMS are skipped (and sent later, since nothing is recorded) until it is paid. Everything else, including recording payments, the parent view and sign-in codes, keeps working: records stay correct and families are not cut off. Platform staff can pause at once by setting the status to "payment overdue". Platform settings changes are not in a school's audit log (there is no platform-wide log yet); the row keeps who changed it last and when.

School choices (N), founder decisions of 2026-11-06: (1) Sibling discounts follow a rule each school sets on Fees, Families (`fees.manage`, whole school): which child pays in full (eldest or youngest by date of birth, or the child in the highest or lowest class; unknowns last, ties by admission number), the second child's discount and the discount for each later child (defaulting to the second's), on one fee item or every item. Families are students in classes this term who share a guardian, directly or through a sibling. Applying the rule (preview first) adds a "Sibling discount (2nd child)" discount to each child who qualifies, replaces its own discounts whose terms changed and ends those that no longer apply; discounts added by hand are never touched (`fee_concessions.source`). Like every discount, it reaches charges when the term is billed; already-billed discounts stay until reversed. (2) Voiding receipts: the Proprietor chooses on Settings, Security whether Accountants may void as well (default: Proprietor only); granted per request (`school_preferences.accountants_can_void`), audited, and every void still needs a reason. (3) A sign-in code sent to a number several schools have is split equally between them: each school is charged 1/n of an SMS, shown to two decimals, and a month's SMS charge is price × SMS rounded to the nearest pesewa. (4) Overview figures (Settings, Profile; Proprietor and Administrator): the collection rate is collected ÷ (owed at the start + billed), the default, or collected ÷ the term's fees; students are flagged below a chosen attendance percentage (default 80) once on a chosen number of registers (default 5).

Paystack (M): Paystack is the Mobile Money provider (`src/server/mobile-money/paystack.ts`), behind the same interface as the mock, so requests, receipts, the ledger, idempotency, held payments and the worker's checks are unchanged. A payment's Paystack reference is `{school id}.{request id}`; Paystack sends webhooks for the whole integration to `/api/v1/mobile-money/callbacks/paystack`, which checks the HMAC-SHA512 signature (`x-paystack-signature`, keyed with the secret key) before storing anything and reads the school from the signed reference; other Paystack events are acknowledged and dropped. As before, the outcome always comes from `transaction/verify` and a receipt is issued only for exactly the amount and currency requested. Networks map to Paystack's codes (MTN `mtn`, Telecel `vod`, AT `atl`). Paystack needs an email per payer: EduBridge sends `payer.{number}@{PAYSTACK_CUSTOMER_EMAIL_DOMAIN}` (`example.com` in test mode). Each school's money settles to its own Paystack subaccount (D-07), entered by platform staff on the school's admin page (`tenant_entitlements.settlement_account`); live payments are refused for a school without one. Live keys are refused unless `PAYSTACK_ALLOW_LIVE=true` (the founder's approval for real money), and need the email domain. Locally, the test key in `.env.local` makes Paystack the provider; end-to-end tests still use the mock. Verified in Paystack's test mode (2026-11-06): the MTN test number 055 123 4987 approves at once and is receipted after verification; other numbers are declined with Paystack's message; an unknown reference is reported as not found; a signed webhook settles a payment and a forged one is refused (`tests/integration/paystack-sandbox.test.ts`, run when `PAYSTACK_TEST_SECRET_KEY` is set). Not verified until live: real prompts (`pay_offline`, then a webhook), and networks that ask for a one-time code (`send_otp`, possibly Telecel), which EduBridge refuses with a clear message for now; card payments; paying from the parent view; creating subaccounts from EduBridge (today they are created in the Paystack dashboard); daily reconciliation against Paystack's records (PAY-04).

Messages to families (O): two SMS the school sends on its own, both off until the Proprietor or Accountant turns them on (Settings, Messages; `fees.manage`), because each SMS is charged. (1) Payment receipts: when any payment is recorded (cash, bank or Mobile Money), the student's primary contact gets the amount, the receipt number and the balance after it, queued in the payment's own transaction so it goes only if the payment is saved; skipped (the payment is still recorded) for demo schools, while SMS are paused for an overdue invoice, beyond the monthly SMS limit, or without a phone. (2) Automatic fee reminders: the worker checks every 15 minutes and runs once a day per school after 9:00 school time (`auto_reminders_last_run_on`, under a per-school lock), reminding families owing at least a chosen amount (default GH₵100) who have not been reminded, by staff or automatically, within a chosen interval (7–90 days, default 14); at most 200 a day, largest balances first, through the same code as staff reminders, audited with no actor. Not sent when the plan leaves out fee reminders or SMS are paused. Announcements (`communication.send`: Proprietor, Head teacher, Administrator) go to the whole school, a campus (when there are several), a level or a class; families are guardian numbers of active students placed this term, so the count shown is one SMS each. Sending by SMS is a choice made after seeing that count and the estimated cost; it is refused beyond the monthly limit (the announcement can still be posted without SMS) or while SMS are paused, and demo schools send none. Announcements are never edited (insert-only); a correction is a new one. Families see the last 120 days' announcements for their children at each school under School news, with the number unread on the family home; opening the page records them as read for that number (`announcement_reads`), and the school sees how many families have read each one. Guardians blocked from the parent view are left out. The student page shows the SMS sent to the family (reminders, receipts, absence SMS) and whether each was delivered. Contact details (Settings, Profile; `school.settings.manage`): office phone (a mobile or a Ghana landline), WhatsApp number, email and office hours, shown on School news and each child's page as tap-to-call, WhatsApp and email links. Not yet: announcements by email, attachments or pictures, scheduling an announcement for later, replies from families, SMS segment counting for long announcements (each SMS counts as one), and per-family opt-out of SMS.

Support access (P), founder decisions of 2026-11-06: the Proprietor turns it on and chooses how long; support can make changes. Settings, Support access (`support.manage`, Proprietor only) allows EduBridge support in for 1 hour, 4 hours, 1 day, 3 days or 7 days (never more than 7 days, also checked by the database), with an optional note on what the school needs; allowing again starts a new period and ends the old one, and "End support access now" applies on support's next page. While a grant (`support_grants`, never deleted, ended once) is live, platform staff who are not members of the school open it from the school's admin page with the Proprietor's permissions, except managing support access and data downloads (`data.export`, `fees.export`); two-step verification applies as on the admin pages. Nothing changes for anyone else: other platform staff without a grant, and every other school, still get "not found". Every page support opens and every form it sends is recorded (`support_views`: path, who, when; the path comes from the proxy, never the browser), and every change support makes is in the audit log tagged with the grant (`audit_events.support_grant_id`, filled by the database from the transaction's `app.support_grant_id`, which every tenant transaction of a support context sets, so no service can forget it). The Proprietor sees past grants with pages opened and changes, and what support did during the latest one; the audit log marks support's changes "EduBridge support". Banners: support sees until when it is in and that it is recorded; the Proprietor sees that support can come in and where to end it. Not yet: emailing the Proprietor when support first opens the school, a request from support asking the Proprietor to allow access, and a platform-wide log of support activity across schools.

Phases Q to U (founder instruction of 2026-11-07, no organisation layer): see ADR 0002 for the design and the decisions still open. In short: the API and the web share services and checks; devices sync through operations that apply once (`sync_operations`) and read changes from a trigger-written feed (`sync_changes`); every student has a learner identity that travels only in signed records (`learners`, `learner_records`, `transfers`, `prior_records`); insights are counted live from records; the assistant reads through the same services and records every question (`assistant_queries`). Not yet: the web register screen moving onto the generic sync queue, offline payments (decision), a desktop client, summary tables for insights, predictions, SMS to tell a family about a transfer request (the receiving school tells them), attaching an imported record to an existing student from the screen (the API supports it), and assistant conversations that keep context between questions (each question stands alone, so every answer is grounded and audited on its own).

Founder decisions of 2026-11-09: (1) The assistant is configured by platform staff (key and switch, Admin, Integrations) and turned on per school by its Proprietor, with names pseudonymised unless the school allows them. (2) The production signing key is platform-managed, stored encrypted and rotatable; records signed earlier still verify. (3) Fees on transfers and record release: each school decides; the balance is shown, nothing is blocked. (4) Offline provisional receipts are optional, turned on by the Proprietor. (5) Transfer consent needs a data-protection and privacy review before production. (6) Paystack live payments stay off until approved. (7) No single-country hardcoding: currency, phone numbering, holidays, level and grading templates, payment providers and networks come from the school's country or its own settings.

Recorded deviations from `01`: FIN-04 and FIN-08 are met with a balance-forward ledger (a term's billed charges act as the invoice; payments reduce the balance), not separate invoice documents with per-invoice allocation; statements, ageing and reports work from the same ledger. Parents have no email channel in R1, so COM-01's finance messages are SMS (staff messages use email). The `MFA_ENCRYPTION_KEY` that seals secrets can be rotated (`npm run keys:rotate`); see `DEPLOYMENT-AND-OPERATIONS.md`.

Teaching model (Z): `school_preferences.teaching_model` is `class` (default; the class teacher enters every subject's marks) or `subject`. `subject_teachers` holds one teacher per subject per class; access to score sheets is worked out per class and subject (`src/server/assessment/teaching.ts`) and used by the score sheets, the assessment list, the class overview and offline score sync. Registers, remarks and report cards follow the class teacher in both models. Switching back to `class` keeps the assignments.

Templates and currency (Y): templates live in `src/lib/curricula.ts` (platform level); a school's choice is `school_preferences.curriculum_template` (null: its country's). Level stages stay five internal keys; each template names them. Money stays integer minor units; formatting, parsing, exports and PDFs use the school's `currency_code` (`formatMoney`, `parseMoney`, `minorDigits`). Assumptions to verify with schools in each country: every non-Ghana template, holiday list and network list.

## R2 completion (founder decision, 2026-11-09: close R2 before R3)

The release-transition review found three R2 items from `01` §6 not built: subject (lesson) attendance, timetables, and report-card templates other than GES. Built:

| Area | Delivered |
| --- | --- |
| Timetables | Timetable (staff navigation): the school day's periods and breaks (no overlaps); each class's lessons per term, Monday to Friday (subject the level takes, teacher suggested from the subject teacher or class teacher); a teacher is never in two classes at once (service message and a unique index); copy from another term without overwriting classes already planned; teachers see their own week, academic staff any teacher's and every class's (campus scope applies); CSV export |
| Lesson attendance | Off until the school turns it on (Settings, Attendance). A register per timetabled lesson, taken by the lesson's teacher, the class teacher or academic staff, with the class register's rules: versioned marks, conflicts shown and never overwritten, insert-only history, the same date limits, offline on the web (same queue and screen) and through `/sync` (`attendance.register` with `periodId`). The class register stays the attendance record (report cards, absence SMS, overview); lesson registers add each subject's attendance this term and, for academic staff, students present at school but absent from a lesson. No SMS for lessons. Undoing a term move is blocked by lesson registers too |
| Report cards | Four layouts, chosen per school (Assessment, Setup) or following the template: GES terminal report (unchanged), British/Cambridge progress report (parts as percentages, comments, no positions), IB (criteria levels as marked, final grade and descriptor), American (percentage, letter grade, grade points, term GPA). Each card keeps the layout it was published in; cards published earlier print as before. Subject comments (400 characters, written by whoever enters that subject's marks, compare-and-set like marks, locked with the published card by a trigger) printed with the teacher's name. Optional grade points on grade bands; GPA = unweighted mean over graded subjects. New starter templates: IB (PYP descriptors, MYP criteria A–D out of 8 and the 1–7 scale) and American (Pre-K to Grade 8, letter grades on a 4.0 scale) |
| Teacher home | Overview shows the teacher's lessons today (with each lesson register's state when lesson registers are on); wording covers subject teachers |
| API | `GET /schools/{school}/lessons/{date}`, `/lessons/{date}/{class}/{period}`, `/timetable/{term}` |

Not yet (recorded, not built): lesson registers in the device change feed (`sync_changes`; devices read them through the endpoints above), Saturday lessons (the data allows weekdays 6–7; screens show Monday to Friday), rooms and room clashes, timetables per campus (periods are school-wide), a parent or student view of the timetable (R3+, student persona), credit-weighted GPA, an effort grade per subject, school logo and signatures on report cards, importing marks, SMS when report cards are published, BECE aggregates and promotion by results. Assumptions to verify: the IB grade boundaries (fixed boundaries on 32 criteria points; IB publishes them per subject), the American letter-grade cut-offs, and that schools want lesson attendance for whole classes rather than sets.

## R3 — Growth (started 2026-11-10, completed 2026-11-10)

Scope from `01` §4 and §6 (bible phases 4 and 8). Requirement IDs are new here because `01` §6 left R3 to be detailed at the start of the release; they need the founder's approval, as do the decisions listed after them. Phases R3-0 and R3-1 need no decision and were built first.

| Phase | Scope | Status |
| --- | --- | --- |
| R3-0 | R3 requirements (this section); stale status notes corrected | Done |
| R3-1 | Notification foundation: NOT-01 to NOT-04 | Built |
| R3-2 | Web push: PSH-01 to PSH-04; with NOT-05 (preferences by channel) | Built for families and staff (staff: new online applications) |
| R3-3 | Events calendar and consent forms: EVT, CNS | Built; the consent statement shown to families needs the legal review before production (`13` L-04) |
| R3-4 | Admissions CRM: ADM | Built (documents on applications not yet) |
| R3-5 | Payment providers: PAY-06 to PAY-09 | PAY-06 and PAY-09 built; PAY-07/08 deferred by the founder (D-R3-3), so not part of R3 |
| R3-6 | Subscription self-service: SUB | Built; SUB-04 in test mode until EduBridge's own Paystack account is verified and live payment approved |
| R3-7 | WhatsApp Business: WAB; with NOT-06 and NOT-07 | Built (founder, 2026-11-10, reversing D-R3-6); goes live once Meta business verification and the templates are approved |

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| NOT-01 | SMS are counted in segments | GSM 7-bit: 160 characters, 153 per part; Unicode (e.g. ₵): 70, 67 per part; extension characters count twice. Limits, usage and charges use segments; the usage row's segments come from the queued message (database trigger), never the caller |
| NOT-02 | Every SMS a school pays for is billed | Payment receipts, announcements, parent-view invitations and fees-billed SMS are billed with reminders, absence SMS and codes; failed messages never |
| NOT-03 | Duplicate prevention | A message with the same idempotency key to the same recipient and channel is queued once (unique index) |
| NOT-04 | Delivery report | Settings, Plan: last 30 days by kind (sent, waiting, not delivered, SMS charged) and the latest failures with reason; numbers masked |
| NOT-05 | Family message preferences by channel | Families choose SMS or push for non-essential messages; essential messages (receipts, fee notices, absence alerts, codes) always reach them |
| NOT-06 | Scheduled messages | Announcements can be scheduled (school time, 5 minutes to 60 days ahead) and cancelled until posted; nothing is sent or charged until then. Event reminders and automatic fee reminders were already scheduled |
| NOT-07 | Handset delivery receipts | WhatsApp: delivered and read from Meta's signed webhook. SMS: only after the SMS provider's delivery callbacks are verified against its documentation (Arkesel's could not be found on 2026-11-10, so SMS still report "accepted by the provider") |
| PSH-01 | Web push opt-in | Parents (by verified number) and staff opt in per device; removed at sign-out and when the push service reports it gone |
| PSH-02 | No sensitive data in push | A push says only that there is something new from the school; details open in the app after sign-in |
| PSH-03 | Push before SMS for non-essential messages | Where the family has push, announcements go by push and cost nothing |
| PSH-04 | Budget | The parent route stays under the 170 KB compressed budget (`01` §8), checked in CI |
| EVT-01 | Events calendar | Events for the school, a campus, a level or a class; shown in the parent view; optional reminder |
| CNS-01 | Consent forms | A form attached to an event or on its own, with a deadline; a guardian answers yes or no from the parent view (verified number); answers insert-only, latest counts; staff see who has not answered and remind them |
| ADM-01 | Inquiries | Staff record an inquiry (family, child, level, term, source) |
| ADM-02 | Online application | A public form per school (`/apply/{school}`, off until the school turns it on); the phone is confirmed by an SMS code before anything is saved; limits per number, network address and school; a hidden field for bots. Documents on applications are not built yet (stored files are never deleted, which conflicts with D-R3-2; documents go on the student once enrolled) |
| ADM-03 | Pipeline | Status: inquiry, applied, assessment, offered, enrolled, declined, withdrawn (acceptance is the enrolment step, which charges the admission fees, D-R3-1); every change kept and audited; closed applications never reopen (trigger) |
| ADM-04 | Assessments and interviews | Scheduled with a date and outcome |
| ADM-05 | Offers | Offer letter PDF; acceptance recorded with date |
| ADM-06 | Enrolment | Accepted applicants become students in one transaction: admission number, guardians matched by phone, class for the term, within the plan's student limit; never twice |
| ADM-07 | Admission fees | Through the existing ledger only (see D-R3-1) |
| ADM-08 | Reporting | Funnel by level, term and source; CSV export |
| PAY-06 | Payment provider per school | Platform staff choose each school's provider (or the deployment default, or Off); prompts, callbacks, worker checks and reconciliation use the provider that sent each prompt; demo schools always use the test provider; Paystack and the mock unchanged (same tests). Per-school credentials come with the first provider that needs them (Paystack uses EduBridge's key and each school's subaccount) |
| PAY-07, PAY-08 | Second and third providers | Behind the existing interface, verified in each provider's sandbox; forged and replayed callbacks refused |
| PAY-09 | Reconciliation per provider | Daily, as PAY-04 |
| SUB-01 | Plan presets | Platform staff define plans; a school's plan starts from one |
| SUB-02 | Plan changes | See D-R3-4 |
| SUB-03 | Invoice PDFs and email | EduBridge invoices as PDF, emailed to the school |
| SUB-04 | Online payment of EduBridge invoices | Paystack hosted checkout on EduBridge's own account (D-R3-5); paid only after Paystack's verify API confirms the full amount and currency; marks the invoice paid once and extends paid until |
| SUB-05 | Automatic status changes | Trial end and paid-until end change the status (audited), with the existing grace period |
| WAB-01 | WhatsApp Business messages | Utility templates from EduBridge's number to families who opted in (parent view); WhatsApp first, SMS on any failure; STOP opts out; per message billing; plan module `whatsapp` |

Decided by the founder on 2026-11-10 (the recommendations below were adopted; D-R3-3 by the founder's own call): **D-R3-1** applicants kept separate from students, with admission and acceptance fees billed through the ledger when an offer is accepted, and no application fee paid before then; **D-R3-2** rejected and withdrawn applications kept 12 months after the decision, then their personal details removed (counts kept for reports); **D-R3-3** no further payment providers for now; **D-R3-4** schools request a plan change and platform staff approve it (no self-service changes while prices are being validated, `13` C-01); **D-R3-5** EduBridge invoices are paid online into EduBridge's own Paystack account, separate from schools' subaccounts, once that account is verified; **D-R3-6** WhatsApp deferred until after R3. The questions as first asked: **D-R3-1** applicants kept separate from students (recommended), with admission and acceptance fees billed through the ledger when an offer is accepted (recommended) rather than an application fee paid before the child is a student; **D-R3-2** how long rejected and withdrawn applications are kept (Act 843 data minimisation); **D-R3-3** the second and third providers and their markets (e.g. Hubtel in Ghana, M-Pesa in Kenya); **D-R3-4** whether schools change plans themselves or request a change; **D-R3-5** EduBridge's own merchant account for invoice payments (separate from schools' accounts, D-07); **D-R3-6** WhatsApp in R3 or later (Meta business verification, a provider and per-conversation cost).

Completing R3 (founder, 2026-11-10: "finish R3 by working on the WhatsApp; choose recommended settings and industry standards"). Decisions taken on that instruction, as recommended: **D-R3-6 reversed** (WhatsApp in R3); **D-R3-7** Meta's WhatsApp Cloud API directly from one EduBridge WhatsApp Business number (no reseller margin; schools named in each message; per-school numbers later); **D-R3-8** utility templates only (no marketing), English, approved in WhatsApp Manager (bodies in the deployment guide, §10); sign-in and application codes stay SMS; **D-R3-9** opt-in by the parent in the parent view (signed in with that number), STOP opts out, both kept with dates (`whatsapp_contacts`); **D-R3-10** WhatsApp first for families who opted in, SMS on any failure (refused at once, or reported failed by the webhook within two days), so no message is lost; **D-R3-11** WhatsApp is a paid plan module (not in new plans by default), one charge per delivered message at a platform price, not counted against the SMS allowance; **D-R3-12** invoice payments by Paystack hosted checkout, confirmed only by Paystack's verify API, live only with `EDUBRIDGE_PAYSTACK_ALLOW_LIVE`; **D-R3-13** scheduled announcements up to 60 days ahead, posted under their author while that member may still send announcements; **D-R3-14** staff push per device under Account, first for new online applications. PAY-07/08 stay deferred (D-R3-3, the founder's own call).

WhatsApp (R3-7): a family SMS of a kind with a WhatsApp template (receipts, fees billed, fee reminders, absence alerts, announcements, parent-view invitations, consent forms, event reminders) is marked when its usage is recorded, if the school's plan includes WhatsApp; the dispatcher then sends it by WhatsApp to numbers that opted in, and by SMS otherwise or on any failure. The SMS allowance is checked as before, but a message that went by WhatsApp is not counted as SMS; billing shows WhatsApp messages separately (Settings, Plan; the admin invoice suggestion adds a line at the platform WhatsApp price). Content is kept until WhatsApp confirms delivery (or two days, then cleared) so a reported failure can still go by SMS. Delivery and read receipts show in the delivery report. Webhook: `/api/v1/whatsapp/webhook` (verify token handshake; every POST checked with `X-Hub-Signature-256`). Not yet: WhatsApp for staff, replies other than STOP (families are told to contact the school), languages other than English, and per-school numbers.

Scheduled announcements (NOT-06): "Schedule it" in the announcement dialog; the Announcements page lists what is waiting, with Cancel; the worker posts each at its time (checked every minute) with its push and SMS, and posts without SMS (recorded on it) if SMS are paused or the allowance is short. Online invoice payment (SUB-04): "Pay online" on an open invoice under Settings, Plan (Proprietor and Administrator, not EduBridge support); the return page and the webhook (`/api/v1/billing/paystack`, signature checked with EduBridge's key) both confirm with Paystack; a payment that does not match is refused and audited; one that arrives after the invoice was settled another way is kept for a refund or credit. Staff push (PSH-01): Account, Notifications on this device; ends with the sign-in; the service worker now also opens school pages (`/s/`).

Subscriptions (R3-6): Plans (platform navigation) holds EduBridge's plans (`plan_presets`): name, description, modules, limits, billing period and usual price in a currency; edited and archived, never deleted. A new school starts on a plan (or one set by hand), and platform staff can set any school's plan from one on its page; the school's plan is a copy (`tenant_entitlements.plan_preset_id` records which), so editing a plan never changes schools already on it, and a plan's price applies only to a school billed in its currency. Plan changes follow D-R3-4: the Proprietor (`plan.request`, not EduBridge support) asks under Settings, Plan for one of the plans offered (shown without prices; EduBridge confirms the price) or for something else in words; one request waits at a time; platform staff are emailed and decide it on the Plans page: approving a request for a plan sets the school's plan from it in the same transaction (audited), approving one in words means staff made the change by hand, declining needs a note; the Proprietor who asked is emailed either way; the school can withdraw while it waits. Invoices (SUB-03): issuing one emails the school's Proprietors with a link to sign in and download it, not an attachment (deviation from "emailed": a financial document stays behind sign-in, and the outbox stays small); the PDF (Settings, Plan, and the school's admin page) prints EduBridge's details and how to pay as set under Billing, Invoice details, and the invoice's state (open, overdue, paid with reference, void with reason). Before production, EduBridge's legal name, address and tax number must be entered there, and the invoice layout checked against Ghana's invoicing rules (a VAT invoice has its own requirements if EduBridge registers for VAT). Automatic status (SUB-05): every 15 minutes the worker applies the rules in the database function `subscription_apply_automatic_status`: a trial whose end has passed becomes active if paid beyond today, otherwise grace, then payment overdue once the platform's grace days are over (which pauses school SMS, as before); an active school whose "paid until" has passed goes the same way; a school the rules moved to grace or overdue becomes active again when staff record payment by extending "paid until"; a status staff set by hand is not undone by the rules (only moved on to overdue when its dates are past the grace period). Each change is audited and the Proprietors are emailed. Demo and suspended schools are left alone. Not yet: online payment of invoices (SUB-04, D-R3-5), invoices issued automatically each period, prorating a change mid-period, and a billing contact other than the Proprietors.

Events and consent forms (R3-3): Events (staff navigation; no plan module, like announcements). `events.view`: every member; `events.manage`: Proprietor, Head teacher, Administrator. An event is for the whole school, a campus, a level or a class (by this term's classes, the same audience rules as announcements, now shared in `src/server/messages/audience.ts`), on one day or several, with optional school-local times and place. The calendar lists coming events by month with the term dates and holidays from the academic calendar; past events (four months) on their own tab. An event can carry a reminder (none; a notification to phones with them on; or that and SMS to the other families), 1, 2, 3 or 7 days before: the worker sends it on that day after 9:00 school time, once (`reminded_at`; a new date or reminder sends it again), and, if the plan's SMS have run out or SMS are paused, only the notifications. The reminder SMS has what, when and where and no link. Cancelling an event shows it as cancelled to families and closes its consent forms. Consent forms (`consent.manage`: Proprietor, Head teacher, Administrator; `consent.view` adds teachers, for their own classes' children only): the school's own wording, for an audience, on its own or for an event (deadline on or before the event), with a deadline. Sending it tells families with notifications on, and by SMS the others when chosen (`sms_usage` kind `consent_request`); "Remind families" goes only to families of children with no answer, at most once a day. In the parent view, forms waiting for an answer are on the family home; a guardian answers yes or no for each child, with an optional note, until the end of the deadline day; any guardian of the child may answer and the latest answer counts; the number used is kept with the answer. The office records signed paper slips (also after the deadline, never for a cancelled form). Answers are insert-only; the wording cannot change once sent (database grants). Staff see each child's latest answer, who gave it and how, and whether it was changed; CSV of every answer and every event under Settings, Data export. Push says only that there is a form or an event reminder (PSH-02). Needs review: the statement under each parent form (that the answer goes to the school with the time and number) and the school-written wording are not legal advice; before production, the data-protection review (`13` L-04) should cover consent wording guidance for schools and how long answers are kept (now: for good, like other school records). Not yet: forms needing both guardians, a signature image, attachments (a trip letter), a printable answer list, repeating events, calendar feeds (iCal), staff-only events, and reminders by email.

Admissions (R3-4): Admissions (staff navigation; plan module `admissions`, included in new plans by default; existing plans need platform staff to add it). `admissions.view`: Proprietor, Head teacher, Administrator, Accountant; `admissions.manage`: Proprietor, Head teacher, Administrator. Applications (`applications`, references A0001 from a per-school counter) are separate from students. Staff record an inquiry or application, schedule an assessment or interview (school-local time, with an outcome note), make an offer (starting term, optional class, reply-by date) and print the offer letter (PDF), then enrol: one transaction creates the student with the next admission number (within the plan's limit), links the parent (reusing a guardian with the same number, so siblings link), places the child in the class for the starting term and charges the offer's admission fees as charges on the ledger (`billing_key` `admission:{application}:{n}`, so enrolling twice charges nothing again). Admission fees are a schedule set by the Proprietor or Accountant (Admissions, Settings) and frozen into each offer. Online applications are off until the school turns them on; each confirmation code is an SMS charged to the school (`sms_usage` kind `application_code`). Report: by level and by source, how many reached each stage (from the history); CSV under Settings, Data export. Retention (D-R3-2): the worker removes names, contact, date of birth and notes from declined and withdrawn applications 12 months after they closed; enrolled ones are kept (the student record took over). Not yet: documents on applications, SMS or email to families from the pipeline (offers are printed or shared), interview calendars, waiting lists and capacity per class, an application fee paid before an offer (D-R3-1 says no), and a family-facing status page.

Web push (R3-2): families turn notifications on per phone in the parent view (Home); the subscription (`push_subscriptions`) belongs to that parent sign-in and is deleted with it (sign-out or expiry, by a foreign key), and the browser unsubscribes when the sign-in page opens. A push says only "a new announcement" from the school and opens its news page (PSH-02); the service worker opens only parent-view paths. Announcements go by push to families with notifications on (free, `announcements.push_count`), and by SMS, when chosen, only to the others; the dialog shows both. A family that turned announcements off gets neither. Essential messages (receipts, fee notices, absence alerts, codes) stay SMS. A 404 or 410 from the push service removes the subscription. Keys: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (deployment guide §3); without them the switch is hidden, and a missing key fails only push, never email or SMS. On iPhone, web push works only once EduBridge is added to the Home Screen; the switch says so. `npm run check:parent-bundle` (in CI after the build) keeps each parent page under 170 KB of compressed JavaScript: 142–147 KB measured on 2026-11-10. Not yet: staff push (no staff message needs it yet), push for other messages (report cards; events and consent forms now have it), and native app push (FCM/APNs) for a future mobile app.

Providers per school (PAY-06, PAY-09): `src/server/mobile-money/config.ts` keeps a registry of the providers this deployment has (Paystack when a Paystack key is set; the mock outside production, or in production only with `MOBILE_MONEY_PROVIDER=mock` or `MOBILE_MONEY_MOCK_SECRET`), the default (`MOBILE_MONEY_PROVIDER`, as before) and each school's choice (`tenant_entitlements.mobile_money_provider`: paystack, mock or none; null follows the default), set by platform staff with the subscription on the school's admin page. Demo schools always use the mock; a real school never does in production unless the mock is the deployment's default. New prompts use the school's provider; checks, callbacks (`/callbacks/{provider}`), the worker's polling and daily reconciliation use the provider stored on each prompt, so changing a school's provider (or turning it off) never strands money already in flight. With several providers, one that sent nothing that day records no reconciliation run.

Notification foundation (R3-1): the outbox stays platform-wide (sign-in codes and password resets belong to no school); a school's messages are attributed through `sms_usage`, which has row-level security, so the delivery report needs no change to the outbox. Allowances are checked before a message (any SMS left) and reduced by its real segments, so a long message can take a school a few segments past its monthly limit; announcements and fees-billed notices check the full segment count before sending anything.

## Pilot readiness (bible Phase 8; founder chose it before R4, 2026-11-17)

Getting R0–R3 ready for a first school rather than adding R4 modules. Work that needs no approval comes first;
going live waits for the founder's decisions listed at the end.

| Step | Result (2026-11-17, local: Windows, PostgreSQL 16 in Docker, Node 22) |
| --- | --- |
| Security review of public surfaces | Webhooks (Paystack, Mobile Money, WhatsApp), `/apply`, `/b`, `/p`, `/logo`, `/verify`, sign-in, uploads and every server action checked. **Fixed:** rate limits and audit IPs read the leftmost `X-Forwarded-For` entry, which the client writes, so the per-address limits on sign-in codes, application codes and password resets could be stepped around; now the entry added by EduBridge's own proxy (`TRUSTED_PROXY_HOPS`, default 1; `src/server/auth/client-ip.ts`). **Upgraded:** Next.js 16.4.3 to 16.4.6 (advisory GHSA-mfr8-8qww-v76h; EduBridge uses neither affected API, but `next build` refused to build). Signatures, body limits, magic-byte file checks, CSP, cookies and per-number limits were sound |
| End-to-end | 100 of 100 passed on a freshly migrated and seeded database. With Playwright's default workers (16 on a 32-core machine) a different few specs timed out each run and two specs raced to bill the same seeded term; local runs now use 4 workers (`E2E_WORKERS` to change) |
| Load at pilot size (`npm run perf:pilot`) | 506 students: import 3 s, billing the term 0.9 s, every staff page under 0.2 s (median). 1,991 students: import 14 s, billing 4.1 s (`01` §10 target: 30 minutes for 500), overview 0.45 s, owing list 0.24 s, insights 0.33 s, others under 0.11 s. The Families page sent 1.1 MB of HTML at that size; since 2026-11-18 it shows 25 families a page, grouped and paged in the database, with a search by guardian, phone, child or admission number, and the sibling changes waiting to be applied list the first 50 (all are applied together); not yet re-measured at 2,000 students. Report-card printing was already measured (400 cards in 10 s, integration test) |
| Backups | **Fixed in the guide:** `pg_dump` as `edubridge_owner` fails, because forced row-level security binds the owner too; backups use a read-only `edubridge_backup` role with `BYPASSRLS` (`DEPLOYMENT-AND-OPERATIONS.md` §2, §5). Restore drill passed locally: counts and the ledger total matched, forced RLS intact on all 85 tenant tables |
| Demo generator | Analyzes tables after its bulk steps (without it, the step after a 2,000-student import took 9 minutes on missing statistics) and no longer repeats payment references at scale |

Not yet, needing the founder: hosting provider and region (D-12) and a staging deployment; the restore
drill and a load check repeated on that provider; Paystack live (D-06/D-07); the data-protection review of
transfers and consent wording (`13` L-04); Arkesel delivery reports checked against their documentation;
Meta business verification for WhatsApp; an error tracker (paid). Engineering follow-up: a load check with concurrent users once staging exists.

## R4 — Operations, on a modular commercial foundation (approved 2026-11-17)

Scope from `01` §6 (bible Phase 6), plus the founder's instruction of 2026-11-17 to make EduBridge a modular
subscription platform before R4 modules are built. The architecture, module inventory, dependency map, database
changes, security and R3 risks are in [ADR 0003](adr/0003-modules-plans-entitlements.md). The founder approved the
requirements below and decisions D-R4-1 to D-R4-8 as recommended on 2026-11-17.

**Prerequisite (still open):** the R3 baseline (everything up to migration 0096) is committed and tagged by the
founder, so that R3 can be deployed and recovered on its own (ADR 0003 §9). Until then, a copy of the tree as it was
before any R4 code (R3, the pilot-readiness fixes and the R4 documents) is kept outside the repository at
`../edubridge-r3-baseline-2026-11-17.tar.gz`.

| Phase | Scope | Status |
| --- | --- | --- |
| R4-0 | Commercial foundation: registry, entitlement resolver and enforcement, add-ons, trials and promotions, release stages, catalogue prices, school and platform screens (MOD, ENT, REL, SUB-06 to SUB-10) | Built (below) |
| R4-1 | Staff and HR, with leave and staff attendance (HR) | Built (below); released 2026-11-18 |
| R4-2 | Payroll records (PRL) | Built (below); released 2026-11-18 |
| R4-3 | Safeguarding (SFG) | Built (below); released 2026-11-18 |
| R4-4 | Visitors and pickup (VIS) | Built (below); released 2026-11-18 |
| R4-5 | Transport (TRN) | Built (below); released 2026-11-18 |
| R4-6 | Inventory, assets and procurement (INV) | Built (below); released 2026-11-18 |
| R4-7 | Library (LIB) | Built (below); released 2026-11-18 |
| R4-8 | Boarding (BRD) | Built (below); released 2026-11-18 |

Commercial foundation (R4-0), as built: the registry is `src/lib/modules.ts` (9 core modules, the 8 R1–R3 plan
modules unchanged, 8 R4 modules at `in_development`, 4 R5 modules `planned`); `src/lib/plan.ts` keeps its names
(`FEATURES` is now the registry's plan modules). Every permission names its module in `PERMISSION_MODULES`
(`src/server/authz/permissions.ts`, exhaustive by type); the ten gated permissions map to the same modules as in
R3 (unit test). The resolver (`src/server/entitlements/service.ts`, pure part `resolveModules`) gives the tenant
context `features` (active modules) and `modules` (each module's state, source and end); background jobs and the
parent side call `moduleActive` instead of reading `tenant_entitlements.features` (six places). Pages: `requireTenant`
refuses a module's own route prefixes (registry `routes`: attendance, assessment, admissions, assistant) with
"not found" when the module is not active, using the proxy-set path; Fees, Mobile Money stays open on purpose so
payments in flight are settled. API: eight school routes declare their module (404 otherwise). Platform staff: a
Modules page (registry by category, stage, how it is sold, needs, permissions, schools with it, catalogue prices,
plan prices, the read-only window, recent changes) and a Modules section on each school's page (state, source and
end of every module, release access, add-ons, trials, promotions and agreements with end dates, earlier ones);
module pickers on plan forms show only modules that can be in a plan, with their stage. Schools: Settings, Plan
lists every module the school has, had or can add, why and until when, with "Ask to add" (catalogue price shown)
and "Ask to cancel" through the existing plan-change requests. The invoice suggestion adds one line per priced
add-on covering the issue date (`addOnInvoiceLines`). Tests: `tests/unit/modules.test.ts`,
`tests/integration/modules.test.ts`. Not yet (prepared, per ADR 0003 §10): instant self-service purchase, invoices
issued automatically each period, proration and discount lines, a release-stage override without a deploy, and
read/change permission pairs for R3 modules (read-only after an end applies from R4 modules).

Staff and HR (R4-1), acceptance criteria written at the start of the phase (module `staff_hr`):

| ID | Acceptance criteria |
| --- | --- |
| HR-01a | A staff record exists with or without an EduBridge account (cooks, drivers and cleaners usually have none), and can be linked to one member, once per school. Each gets a staff number from a per-school counter (S0001), never reused |
| HR-01b | Personal details: names, sex, date of birth, phone (the school's country form), email, address, qualifications, emergency contact (name, relationship, phone). No government identifiers (Ghana Card, SSNIT) in R4-1: payroll decides, with the data-protection review |
| HR-01c | Employment: type (permanent, contract, part-time, national service, volunteer, casual), department, position, campus, start date; leaving with a date and reason, and returning. Every change is an insert-only employment event with its effective date, so the history is never lost; the record holds the current state |
| HR-01d | Staff documents (contracts, certificates): PDF or image up to 5 MB, private, every download recorded in the audit log, removed (never deleted) |
| HR-01e | Campus scope: staff limited to some campuses see and change only staff of those campuses (and staff with no campus) |
| HR-02 | Departments and positions are the school's own lists, archived not deleted. A linked member's teaching (class teacher, subject teacher) is shown from the existing records, never copied |
| HR-03a | Leave types are the school's own: name, days a year (none: no limit) and paid or unpaid. Suggested Ghana defaults, to verify with pilot schools: annual 15 working days (Labour Act 2003, minimum), sick (no limit), maternity 60 working days (12 weeks), paternity 5, compassionate 5, study (unpaid, no limit) |
| HR-03b | A member with a staff record asks for their own leave; leave approvers record leave for anyone. Days are working days, Monday to Friday, less the school's holidays. A request overlapping other waiting or approved leave of the same person is refused; beyond the year's balance needs the approver to confirm |
| HR-03c | Approving or declining is once, by an approver who is not the person on leave, with a note when declining; the person asking can cancel while it waits or before it starts, an approver at any time. Every step is audited and kept |
| HR-03d | Balances per leave year (calendar year): days a year less approved days falling in that year |
| HR-04 | Staff attendance per day: present, late, absent or off duty; approved leave shows as on leave and cannot be marked otherwise. Changes apply only from the version shown, so nobody silently overwrites anyone (as class registers); every correction is audited with before and after |
| HR-05 | Permissions: `staff.view` (Proprietor, Head teacher, Administrator), `staff.manage` (the same), `staff.documents` (Proprietor, Administrator), `leave.approve` (Proprietor, Head teacher, Administrator), `leave.request` (every staff role, own record only), `staff.attendance` (Proprietor, Head teacher, Administrator). When an add-on for the module ends, viewing and downloading stay allowed for the read-only window (ENT-08), changes do not |

Assumptions to verify with pilot schools: the leave defaults above and the calendar leave year; that schools
want leave approved by the Proprietor, Head teacher or Administrator (no per-department approvers yet); working
days ignore public holidays outside the school's recorded holidays. Not in R4-1: payroll and salary (R4-2), SMS or
push to staff about leave, carrying unused leave into the next year, half days, staff self-service sign-in for
staff without an account, and imports of staff from a spreadsheet.

Staff and HR (R4-1), as built: services in `src/server/staff` (`records.ts`, `leave.ts`, `attendance.ts`), shared
values and the leave arithmetic in `src/lib/staff.ts`; pages Staff (people, a profile per person with personal
details, employment and its history, teaching from the class and subject records, leave balances and requests,
documents), Staff, Attendance (one day at a time, marks saved only from the version shown; conflicts listed) and
Staff, Settings (leave types with the suggested Ghana types, positions, departments); and Leave for every member
(their balances and requests, asking and cancelling; for approvers the requests waiting, who is away today and
the next 30 days). Migrations `0099_staff_hr` and `0100_staff_hr_rls`. The module is at stage `internal_testing`:
demo schools and schools given release access reach it (the seed gives Kpone Ridge access for development and the
end-to-end tests); the founder moves it to `pilot`. Personal details changes are audited by field name only, so
the audit log does not copy phone numbers or addresses. Pages also check access themselves (pages render
alongside their layout); the same check was added to the Assessment and Fees pages, which logged a permission
error when a member without access opened them (the member always saw "not found").

Payroll records (R4-2), acceptance criteria written at the start of the phase (module `payroll`, needs `staff_hr`):

| ID | Acceptance criteria |
| --- | --- |
| PRL-01a | Pay components are the school's own: earnings, deductions and employer contributions, each a fixed amount or a percentage of basic salary or of gross pay. No statutory rates are built in: SSNIT, PAYE and similar are entered by the school as components (bible 5.13) and the suggested names carry no rates |
| PRL-01b | Each person's salary is a basic amount and the components that apply to them (an amount or a percentage each), effective from a month. A change is a new salary from a later month, never an edit, so earlier months are always reproducible |
| PRL-02a | A payroll run per school per month: prepared as a draft from the salaries in force that month (staff who worked at any point of the month), recalculated freely while a draft, then approved by the Proprietor and locked by the database. A run can be cancelled while a draft; an approved run never changes |
| PRL-02b | Corrections are adjustments (an earning or a deduction, with a reason) applied in the next run, never edits of an approved month. Each adjustment is applied once |
| PRL-02c | Money is integer minor units in the school's currency; percentages are basis points, rounded half up per line. A run with a negative net pay cannot be approved. Each line keeps a frozen copy of its components' names and amounts |
| PRL-03 | Payslips (A5 PDF) per person from an approved run; a run summary (gross, deductions, net, employer contributions) and a CSV export for the bank or accountant. EduBridge does not pay anyone. Staff with an account see their own approved payslips |
| PRL-04 | Permissions: `payroll.view` and `payroll.manage` (Proprietor, Accountant), `payroll.approve` (Proprietor), `payroll.own` (every staff role, own payslips). Salaries are hidden from the Head teacher and Administrator. Viewing and exporting stay allowed while the module is read-only (ENT-08) |

Assumptions to verify with pilot schools: monthly pay only; no proration for part months (entered as an adjustment);
unpaid leave is deducted by adjustment, not automatically; one currency (the school's). Not in R4-2: statutory tax and
pension calculation, bank transfer files in a bank's own format, loans and advances schedules, payslips by SMS or
email, and bank account numbers (kept out until the data-protection review).

Payroll records (R4-2), as built: arithmetic in `src/lib/payroll.ts` (pure, unit-tested: half-up rounding per
line, gross, deductions, employer contributions, net), services in `src/server/payroll/service.ts`, payslip PDF in
`src/web/pdf/payslip.tsx`. Pages: Payroll, Months (prepare a month; each month's totals; your own payslips), a
month (people, totals, Recalculate, Cancel draft, Approve for the Proprietor, CSV download, payslip per person;
warnings for people without a salary, a stale draft and negative net pay), Salaries (everyone working this month
and their salary) with a page per person (salary history, set salary from a month, adjustments), and Components.
Staff without payroll access see Payslips (their own approved payslips) instead. Approving is refused while
salaries or adjustments changed after the draft was prepared, so what the Proprietor approves is what was
calculated. Salary amounts are not copied into the audit log. Migrations `0101_payroll` and `0102_payroll_rls`.
Stage `internal_testing`; the seed gives both seeded schools release access to Staff and HR and Payroll records.
Fixed alongside: Fees, Reports CSV downloads started with two byte-order marks (a stray character in Excel's first
cell); now one, checked by the end-to-end tests.

Safeguarding (R4-3), acceptance criteria written at the start of the phase (module `safeguarding`, in every plan,
never sold on its own, D-R4-4):

| ID | Acceptance criteria |
| --- | --- |
| SFG-01a | Any staff member reports a concern about a student: category (physical, emotional or sexual harm, neglect, bullying, self-harm, online safety, other), what happened, when and where, and anything done at once. The report gets a reference (SG0001) and its account never changes afterwards; later information is added as notes |
| SFG-01b | Cases are seen only by the school's designated safeguarding leads, appointed and ended by the Proprietor (D-R4-6). The database enforces it (row-level security): no other member, no background job, insight or assistant, and no EduBridge support session can read a case, its notes or documents. A reporter sees only that their report was received |
| SFG-01c | Leads record follow-up: notes, actions with a due date (done once), referrals, contact with the family and meetings; assign a lead; move a case to monitoring or close it with a note, and reopen it. The case history is insert-only |
| SFG-01d | Every time a lead opens a case or downloads one of its documents is recorded, and the record is shown on the case |
| SFG-01e | Confidential documents (PDF or image up to 5 MB) are stored with the case, under the same lead-only rule, and are removed rather than deleted |
| SFG-01f | Safeguarding is left out of data exports, insights, the assistant, the student page and the general audit log (which other staff can read); its own history is the audit trail |

Assumptions to verify with pilot schools and the data-protection review (`13` L-04): the categories; that leads,
not the Proprietor by default, see cases (the Proprietor can appoint themselves); that reporters are told only
"received". Not in R4-3: referral letters, reports to outside agencies, cases about staff, support access to cases
when a Proprietor allows it for a period (support is always excluded), notifications to leads, and boarding
incidents (R4-8).

Safeguarding (R4-3), as built: service `src/server/safeguarding/service.ts`, values `src/lib/safeguarding.ts`.
Pages: Safeguarding for every member of staff (who the leads are, Report a concern, Your reports) and, for leads,
the cases with status, lead and actions to do; a case page (the report as written, lead, history with Record,
Mark done, Move to monitoring, Close case with a reason, Reopen, documents and who opened the case); Settings,
Safeguarding for the Proprietor (appoint and end leads). Leads are a school grant (`safeguarding.manage` added
to the tenant context for an active lead), not a role, so the Proprietor sees cases only if they appoint
themselves. The database function `app_is_safeguarding_lead()` backs the row-level security on cases, entries,
access records and documents (cases also readable by their reporter); the integration tests read the tables
directly as the Proprietor, the Accountant, a user-less job and another school and get nothing. Documents are in
`safeguarding_documents`, not in `stored_files`. Registry: `everyPlan` makes the module part of every plan whatever
the plan lists (D-R4-4); release stages still apply (`internal_testing`). EduBridge support is excluded from all
three permissions. The seed makes Kpone Ridge's head teacher its lead. Migrations `0103_safeguarding` and
`0104_safeguarding_rls`.

Visitors and pickup (R4-4), acceptance criteria written at the start of the phase (module `visitors_pickup`, in
Professional and as an add-on, D-R4-4):

| ID | Acceptance criteria |
| --- | --- |
| VIS-01a | The office signs a visitor in: name, phone (optional, the school's country form), organisation (optional), purpose (meeting, parent or family, delivery, contractor or repairs, official visit, interview, other), who they are visiting (a member of staff, or written in), campus when the school has more than one, badge number and a note (optional). The time is the server's |
| VIS-01b | On site now: visitors signed in and not out, at the member's campuses, with when they arrived (visitors from an earlier day still not signed out are marked). Signing out is once, with the time and who did it; nothing else about a visit changes and visits are never deleted (database) |
| VIS-01c | The visitor log for any day, at the member's campuses |
| VIS-02a | Who may collect each child: the child's guardians marked "May collect the child" on the student record (shown, never copied), and named other collectors (name, relationship, phone, optional photo, optional last day, note) added by the office and ended once with a reason; never deleted. A one-off collector is added with a last day of today |
| VIS-02b | Releasing a child names who collected them, chosen from those allowed at that moment (a guardian still linked and marked, a collector not ended and not past their last day); anyone else is refused by the server |
| VIS-02c | When someone not allowed comes, staff record a refusal with the person's name, what they said they are to the child, and why. Refusals are listed on the day's page |
| VIS-02d | The day's pickup list by class: each child's latest release or refusal (who, when, recorded by) and those not yet collected. A record made by mistake is cancelled once with a reason and kept; records are otherwise never changed or deleted (database) |
| VIS-03 | Permissions: `visitors.view` and `visitors.manage` (Proprietor, Head teacher, Administrator); `pickup.view` and `pickup.record` (Proprietor, Head teacher, Administrator, Teacher, for children of every class at their campuses, since staff on gate duty release any child); `pickup.manage` (Proprietor, Head teacher, Administrator: collectors, and phone numbers). Viewing stays allowed while the module is read-only (ENT-08). Collector changes and cancelled pickups are in the school's audit log, without phone numbers. The visitor log and pickup records are in Settings, Data export |

Assumptions to verify with pilot schools and the data-protection review (`13` L-04): the purposes; that teachers
on gate duty release children of any class; how long visitor names and phone numbers are kept (now: for good, like
other school records). Not in R4-4: SMS or notifications to families when a child is collected, families managing
collectors in the parent view, collection codes or QR passes, visitor photos, ID scanning and printed badges,
visitors booked in advance, late-collection alerts, and a sign-in screen for visitors themselves.

Visitors and pickup (R4-4), as built: services `src/server/visitors/visits.ts` and `src/server/visitors/pickup.ts`,
shared values and rules (who may collect today, each child's latest record) in `src/lib/visitors.ts`. Pages:
Visitors (on site now with Sign out, visitors from an earlier day still in marked, Sign in a visitor, the log for
any day) and Pickup (refusals today; a class's list for today, opening on a class teacher's own class, with each
child's latest release or refusal, who may collect them, Release with photos and Refuse), with a page per child
(who may collect them: guardians from the student record, named collectors with Add and End; guardians not
allowed; history with Cancel). Release names a guardian or collector from the list; the server checks the person
is allowed at that moment (locking the guardian link or the collector), so a page left open after a change cannot
release a child to someone no longer allowed. Collector photos are stored files (`collector_photo`, 500 KB) served
by an access-checked route. The visitor log, pickups and collectors are three CSV files in Settings, Data export.
Migrations `0105_visitors_pickup` and `0106_visitors_pickup_rls`. Stage `internal_testing`; the seed gives both
seeded schools release access and lets the seeded parents collect their children (new seeds only).

Transport (R4-5), acceptance criteria written at the start of the phase (module `transport`, a plan module and
add-on):

| ID | Acceptance criteria |
| --- | --- |
| TRN-01a | Vehicles: name, registration, seats, driver and attendant (names and phone; drivers need no EduBridge account), note; archived, never deleted |
| TRN-01b | Routes: name and vehicle; stops in order, each with a morning and afternoon time. Routes and stops are archived, never deleted |
| TRN-01c | Each student rides at most one route per term: a stop on it, and both ways, to school only or home only. Changing a route ends the old assignment and starts a new one; ended assignments are kept (database). Only students at the school this term can be assigned |
| TRN-02a | Fares: the school chooses which optional fee item is transport, and sets a fare per term on each route, which a stop can override. Fares are set by those who manage fees (Proprietor, Accountant), in the school's currency |
| TRN-02b | Billing the term (the existing Fees, Billing) charges the transport item to each student assigned that term, at their stop's fare (or the route's), through the ledger like any fee. Students not assigned are not charged it. A route change or a new fare after billing never changes a charge: it shows as a difference for the Accountant to reverse and bill again, as for every fee |
| TRN-03a | Trips: for a route, a day and a direction (morning to school, afternoon home), staff on the bus mark each child boarded and, later, got off (at school or at their stop), with the time. Each mark is made once and never changed or deleted (database) |
| TRN-03b | Families are told by a push notification to phones with notifications on, saying only that there is a bus update; the parent view shows the child's route, stop and times, and today's boarding and getting off. No location tracking (GPS is later, optional and consent-based, bible 5.15) |
| TRN-04 | Permissions: `transport.view` (Proprietor, Head teacher, Administrator, Accountant), `transport.manage` (Proprietor, Head teacher, Administrator: vehicles, routes, stops, assignments, notifications), `transport.trips` (the same and Teachers: marking trips). Fares and the transport fee item need `fees.manage`. Viewing stays allowed while the module is read-only (ENT-08). Changes are in the school's audit log; routes, assignments and trips are in Settings, Data export |

Assumptions to verify with pilot schools: one fare per term whether a child rides both ways or one way; one route
per child per term; staff on the bus (attendant or teacher) mark trips on a phone; push only for families. Not in
R4-5: SMS for each boarding (two SMS a day per child, a cost the founder should decide), GPS and live location,
correcting a mark made by mistake, fares charged per trip or per month, fuel and maintenance records (inventory,
R4-6), driver licence and vehicle insurance expiry reminders, and routes limited to a campus.

Transport (R4-5), as built: services in `src/server/transport` (`setup.ts` vehicles, routes, stops, fares and
settings; `assignments.ts`; `trips.ts` with the parent-view reader; `billing.ts`), rules in `src/lib/transport.ts`.
Pages under Transport: Routes (vehicle, stops, students this term, fare), a page per route (stops in order with
times and fares, Edit and Archive, Fares for those who manage fees, students this term), Students (put on a route
or moved, taken off, with the fare billing will charge), Trips (a route and direction, today; On the bus, then At
school or Got off, per child; recent trips), Vehicles and Settings (the transport fee item; whether families are
told). Teachers see Trips only. Billing: `planBilling` takes one per-student item, so the term's billing charges the
transport item from each open assignment's fare (stop, else route) with the usual billing keys, ignores structure
lines and student fee options for that item, and reports a route change or new fare after billing as a difference
(unit and integration tests). While the module is not active, or no transport item is chosen, the item is billed
like any optional item again. The transport item is hidden from a student's optional items while Transport decides
it. Push template `transport_push` carries only the school and a link to the child's page; the parent view has a
School bus section (route, stop, times, today's marks). Routes, assignments and trip marks are two CSV files in Data
export. Migrations `0107_transport` and `0108_transport_rls`. Stage `internal_testing`; the seed adds a bus and one
route with two stops at Kpone Ridge, without a fee item, so seeded fees are unchanged. Fixed alongside: the Staff and
Transport tab bars cancelled the space below them (their content sat against the tabs); the phone sign-in E2E test
now waits for the sign-in page to settle after redirects (sign-in itself works without scripts, checked).

Inventory, assets and procurement (R4-6), acceptance criteria written at the start of the phase (module
`inventory_assets`, a plan module and add-on):

| ID | Acceptance criteria |
| --- | --- |
| INV-01a | Stock items (chalk, paper, cleaning supplies): name, category, unit, reorder level; archived, never deleted. Stock changes only by movements: received (with an optional supplier and unit cost), issued (to whom or where) and counted (a correction to what is really on the shelf, with a reason). Movements are never changed or deleted (database); what is on hand is their sum, never typed in |
| INV-01b | An issue larger than what is on hand is refused; two people issuing at once cannot take stock below zero. Items at or below their reorder level are listed as low |
| INV-01c | Asset register: each asset gets a tag from a per-school counter (A0001, never reused): name, category, serial number, location, custodian (a member of staff or a name), condition, acquired on, cost and supplier. Moving it, changing its custodian or condition, and disposing of it (with a reason, once) are kept as its history, never edited |
| INV-02a | Suppliers: name, contact person, phone, email, note; archived, never deleted |
| INV-02b | Purchase requests (PR0001): what is needed as lines (description, quantity, estimated unit price, optionally a stock item), supplier and why. The Proprietor approves or declines once, with a note when declining, and never their own request; the person asking can cancel while it waits. Receiving an approved request records what arrived and, for lines with a stock item, adds it to stock. Totals in the school's currency (integer minor units). EduBridge does not pay suppliers |
| INV-02c | Maintenance requests (MR0001): any member of staff reports what needs fixing, where, how urgent, and optionally which asset. The office moves it to in progress, done (with what was done) or cancelled; every change is kept with who and when. Reporters see their own requests |
| INV-03 | Permissions: `inventory.view` (Proprietor, Head teacher, Administrator, Accountant), `inventory.manage` (Proprietor, Administrator, Accountant: stock, assets, suppliers, receiving), `purchases.request` (the same four as viewing), `purchases.approve` (Proprietor), `maintenance.report` (every staff role), `maintenance.manage` (Proprietor, Head teacher, Administrator). Viewing stays allowed while the module is read-only (ENT-08). Changes are in the school's audit log; stock movements, assets, purchase requests and maintenance requests are in Settings, Data export |

Assumptions to verify with pilot schools: whole-number quantities (a ream, a box, a bag); the Proprietor alone
approves purchases, whatever the amount; one register for the whole school (no campus scope). Not in R4-6: paying
suppliers or recording expenses (that is accounting, not built), purchase orders sent to suppliers, approval limits
by amount, depreciation, barcode or QR labels, stock at several stores, and preventive maintenance schedules.

Inventory, assets and procurement (R4-6), as built: services in `src/server/inventory` (`stock.ts`, `assets.ts`,
`suppliers.ts`, `purchases.ts`, `maintenance.ts`, shared helpers in `common.ts`), rules in `src/lib/inventory.ts`.
Pages under Inventory: Stock (on hand from movements, low items) with a page per item (Receive, Issue, Correct count,
movements), Assets with a page per asset (Move or hand over, Edit details, Dispose of, history), Purchases with a
page per request (lines and total; Approve and Decline for the Proprietor, not on their own request; Cancel;
Receive with how many arrived), Maintenance with a page per request (Update for the office, history) and Suppliers.
Staff who only report repairs see Maintenance alone (their own reports). Issues lock the item row, so two people
issuing at once cannot go below zero (integration test). Tags and references come from per-school counters. The
database refuses: changing or deleting stock movements, asset events and maintenance updates; deleting stock items,
suppliers or assets; changing a disposed asset or an asset's tag; a decision by the person who asked; a purchase or
maintenance request moving backwards. Four CSV files in Data export. Migrations `0109_inventory` and
`0110_inventory_rls`. Stage `internal_testing`; the seed adds two stock items and one asset at Kpone Ridge. The
Proprietor's approval is tested end to end only for their own request (refused) at Adenta Hall, since Kpone Ridge
asks its Proprietor for two-step verification; approving and receiving are covered by the integration tests. Fixed
alongside: the phone navigation drawer did not scroll, so its last links could not be reached once the menu grew. Seven end-to-end specs were brought up to date with the redesigned screens (profile menu, overview figures, calendar year rows, confirmations as toasts).

Library (R4-7), acceptance criteria written at the start of the phase (module `library`, a plan module and add-on):

| ID | Acceptance criteria |
| --- | --- |
| LIB-01a | Catalogue: title, author, ISBN (10 or 13 digits, checked, one title per ISBN), publisher, year, category; archived, never deleted. Search by title, author or ISBN, with how many copies are in and out |
| LIB-01b | Copies: each copy gets a number from a per-school counter (B0001, never reused) and a shelf; a copy is withdrawn (lost, damaged, discarded) once with a reason and kept |
| LIB-01c | Loans to a student at the school or a member of staff: by copy number, due after the school's loan period (default 14 days), up to the school's limit of books at once (default 3). A copy on loan cannot be lent again (database). Renewing moves the due date on from today; returning closes the loan once; a lost book closes the loan and withdraws the copy. Loans are never deleted |
| LIB-01d | Overdue list: open loans past their due date, with how many days late, by class |
| LIB-01e | Reservations: when no copy is in, a borrower is put in a queue for the title. A returned copy is held for the first in the queue (shown when it is returned), and lent only to them until they collect it or the reservation is cancelled |
| LIB-02 | Fines, off unless the school turns them on: an amount per day late and a maximum, set by those who manage fees. When a student returns a book late, the fine is charged to their fee account through the ledger, once per loan (billing key), in the school's currency. A fine is waived by reversing it on the student's account, as any charge. Staff are not fined |
| LIB-03 | Permissions: `library.view` (every staff role: catalogue and availability), `library.manage` (Proprietor, Head teacher, Administrator: catalogue, copies, loans, returns, reservations, loan rules); fines settings need `fees.manage`. Viewing stays allowed while the module is read-only (ENT-08). The parent view shows a child's books on loan and when they are due. Changes are in the school's audit log; the catalogue and loans are in Settings, Data export |

Assumptions to verify with pilot schools: a teacher running the library is given the Administrator role (no
librarian role yet); fines count calendar days, weekends included; one loan period for every book. Not in R4-7:
self-service borrowing, barcode scanning hardware (a scanner that types the copy number works), charging for lost
books automatically (the Accountant adds a charge), e-books, inter-school loans, and reminders by SMS.

Library (R4-7), as built: services in `src/server/library` (`catalogue.ts`, `loans.ts` with rules, reservations and
the parent-view reader, `borrowers.ts`), rules in `src/lib/library.ts` (ISBN check digits, days late, fines). Pages
under Library: Catalogue (search by title, author or ISBN; copies in, out and waiting) with a page per book (copies
and where each is, Add copies, Withdraw, Reserve when none is in, the queue with Cancel), Loans (the desk: lend and
return by copy number, with the outcome kept on screen; books out, most overdue first, with Return, Renew and Lost)
and Settings (loan period and books at once for the library; fines for those who manage fees). Teachers see the
catalogue and loans, not the desk. A late student's fine is a `charge` on the ledger with billing key
`library:<loan>`, counted from the first open day (FIN-16), so a return can never charge twice; a fine is waived by
reversing it on the student's account. Renewing is refused for an overdue book or one someone is waiting for. The
database refuses a second open loan for a copy, changes to a closed loan, a reservation moving backwards, renumbering
or deleting copies. The parent view lists a child's books on loan. Two CSV files in Data export. Migrations
`0111_library` and `0112_library_rls`. Stage `internal_testing`; the seed adds two books and copies B0001 to B0003 at
Kpone Ridge. The release-access integration test now uses Boarding as the module still being built.

Boarding (R4-8), acceptance criteria written at the start of the phase (module `boarding`, a plan module and
add-on):

| ID | Acceptance criteria |
| --- | --- |
| BRD-01a | Houses (boys, girls or mixed), rooms in a house, and beds in a room; archived, never deleted |
| BRD-01b | House staff (housemasters and housemistresses): the office appoints and ends members of staff for a house. House staff see their own house and sign its boarders out and in, without another role |
| BRD-01c | Each boarder has one bed per term, and each bed one boarder per term (database). A girl is not placed in a boys' house, nor a boy in a girls' house. Moving ends the old assignment and starts a new one; ended ones are kept. Only students at the school this term are placed |
| BRD-02 | Boarding fees through the ledger: the school chooses which optional fee item is boarding, and sets its amount in the fee structure by level or class as for any fee. Billing the term charges it to each student with a bed that term, and to nobody else; a change after billing shows as a difference for the Accountant, as for every fee |
| BRD-03 | Exeat: a boarder signed out (reason, who collected them, when they are expected back) and signed back in, each once, with who did it; never deleted. One exeat open at a time per boarder. Boarders out now and overdue are listed |
| BRD-04 | Concerns about a boarder are reported as safeguarding cases (R4-3), linked from the house; boarding keeps no incident records of its own |
| BRD-05 | Permissions: `boarding.view` (Proprietor, Head teacher, Administrator, Accountant), `boarding.manage` (Proprietor, Head teacher, Administrator: houses, rooms, beds, house staff, placing boarders), `boarding.exeat` (the same, and house staff for their house). The fee item needs `fees.manage`. Viewing stays allowed while the module is read-only (ENT-08). The parent view shows a child's house, room and bed, and whether they are out on exeat. Changes are in the school's audit log; placements and exeats are in Settings, Data export |

Assumptions to verify with pilot schools: one boarding fee per term by level or class (not by house); exeats are
recorded by house staff or the office, with families informed by the school as today; house staff are teachers or
other members with an account. Not in R4-8: roll calls and night checks, visiting days, a sick bay, meals, boarders'
pocket money, SMS to families on exeat, and families asking for an exeat in the parent view.

Boarding (R4-8), as built: services in `src/server/boarding` (`houses.ts` houses, rooms, beds, house staff and the
fee item; `boarders.ts` placing boarders, exeats, the billing and parent-view readers; `billing.ts`), rules in
`src/lib/boarding.ts`. Pages under Boarding: Houses (beds taken, boarders out, house staff) with a page per house
(rooms and who sleeps in each bed, Give a student a bed, Take out, Add a room, Add beds, Out of use, house staff with
Appoint and End, and a link to report a safeguarding concern), Exeats (out now with overdue days and Back in; the
last 30 days) and Settings (the boarding fee item, for those who manage fees). House staff are a school grant
(`boarding.view` and `boarding.exeat` in the tenant context while appointed), so a teacher appointed to a house sees
that house only. Billing: term billing charges the boarding item at the fee structure's amount for the student's
level or class to students with a bed that term, and to nobody else, with the usual billing keys and differences.
The database keeps one open bed per boarder and one boarder per bed per term, one open exeat per boarder, and
refuses deleting or rewriting placements, exeats and house staff. The parent view shows the house, room, bed and an
open exeat. Two CSV files in Data export. Migrations `0113_boarding` and `0114_boarding_rls`. Stage
`internal_testing`; the seed adds a mixed house with one room of four beds at Kpone Ridge. With this phase every R4
module is built; the release-access integration test now uses Collection forecasting (R5, planned) as the module not
ready for schools.

Each operational module starts at stage `in_development`, moves to `pilot` only after its tests pass and the
founder approves, and is off in every plan until then. Detailed acceptance criteria for R4-2 to R4-8 are written
at the start of each phase (as `01` §6 asks); the summaries below fix their scope.

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| MOD-01 | One module registry covers the whole product | Every built, R4 and planned R5 module has an id, name, description, category, release stage, commercial availability (core, plan module, add-on), dependencies, permissions, route prefixes and navigation entries; the existing eight ids are unchanged |
| MOD-02 | Every permission belongs to a module | The permission-to-module map is exhaustive (type check); a test asserts that each R3 permission maps to the same module as before |
| MOD-03 | Dependencies are explicit | Granting a module without its dependencies is refused with a message naming them; a lapsed dependency switches its dependants off |
| ENT-01 | One resolver decides each school's modules | Plan modules + current add-ons, trials and promotions + core modules, filtered by release and dependencies; states `active`, `read_only`, `off`, with source and end date |
| ENT-02 | Services refuse unentitled actions | `assertAllowed` uses the resolver; a role never overrides a missing module; school grants and support access too |
| ENT-03 | Pages, direct URLs, server actions and downloads refuse unentitled modules | "Not found" from the route check in `requireTenant`, using the proxy-set path; registry-driven test over every declared route prefix |
| ENT-04 | The API refuses unentitled modules | Each API route declares its module; 404 for a school without it; tested |
| ENT-05 | Navigation and settings show only active modules | Generated from the registry; read-only modules show as such |
| ENT-06 | Background jobs and the parent side respect entitlements | Every per-school job and parent-side check goes through the resolver; retention and purge jobs and settling money in flight always run (documented) |
| ENT-07 | Ending a module never deletes data | Records kept; data export always includes them; reactivation restores access |
| ENT-08 | Read-only after an add-on, trial or promotion ends (R4 modules) | Read and export allowed, changes refused, for a retention window (platform setting, default 90 days), then off; R3 modules unchanged (D-R4-5) |
| ENT-09 | Changes take effect at once and are audited | Next request and next worker cycle; every grant, end and plan change in the school's audit log, and catalogue and release changes in the platform log |
| REL-01 | Release stages separate from entitlements | `planned`, `in_development`, `internal_testing`, `ready`, `pilot`, `general`, `deprecated`, `retired` in the registry; `in_development` unreachable in production |
| REL-02 | Pilot and internal access per school | Platform staff grant and end release access per school and module (audited); demo schools see internal-testing modules |
| SUB-06 | Add-ons, trials and promotions per module | Platform staff add a module to a school with a source, start, optional end, billing period and agreed price, and end it once with a reason; kept as history |
| SUB-07 | Catalogue prices are configuration | Prices per plan and per add-on, per billing period (monthly, termly, annual) and currency, flat or per active student; nothing hardcoded; no price is entered by engineering |
| SUB-08 | Schools see and request modules | Settings, Plan: included modules, add-ons with end dates, read-only modules, available add-ons (released and purchasable), usage against limits; request an add-on or a cancellation through the existing plan-change request |
| SUB-09 | Invoices include add-ons | The invoice suggestion adds a line per paid add-on for the period (per-student prices use active students on the issue date) |
| SUB-10 | Platform Modules page | Registry with stages, dependencies, prices, which schools have each module and release access; entitlement history per school |
| HR-01 | Staff records | Staff profiles (with or without an EduBridge account), employment records (start and end, contract type, position, department), documents (private, views recorded), emergency contacts; campus scope applies |
| HR-02 | Departments and positions | Configurable per school; teacher assignments stay with classes and subjects (no duplicate) |
| HR-03 | Leave | Leave types and yearly entitlements per school, requests, approval by a named role, balances, calendar; audited |
| HR-04 | Staff attendance | Daily staff attendance (present, late, absent, on leave from approved leave), corrections audited |
| PRL-01 | Salary structures | Configurable components per school (earnings and deductions, fixed or percentage), no built-in statutory rates; SSNIT, PAYE and similar entered by the school as components until validated (bible 5.13) |
| PRL-02 | Payroll records | Monthly payroll run per school: draft, approved by the Proprietor, then locked; corrections as an adjustment in a later run, never edits; integer minor units in the school's currency |
| PRL-03 | Payslips and reports | Payslip PDFs, payroll summary and export (CSV) for the bank or accountant; payroll is not paid out by EduBridge |
| SFG-01 | Restricted safeguarding records | Incident reports by any staff member; cases visible only to the designated safeguarding lead(s) granted by the Proprietor; every view recorded; follow-up actions and audit history; confidential documents; out of insights, the assistant and ordinary exports (D-R4-6) |
| VIS-01 | Visitors | Sign in and out with purpose and person visited; today's visitors on site |
| VIS-02 | Pickup | Authorised collectors per student (built on guardian roles, plus named non-guardian collectors with photo); pickup recorded against the authorisation; refusal recorded |
| TRN-01 | Routes and assignments | Vehicles, drivers, routes, stops, student assignments per term |
| TRN-02 | Transport fees | Charged through the existing ledger as fee items per route or stop |
| TRN-03 | Trip records | Boarding and arrival per trip; families told by the existing notification channels; GPS not in R4 (optional and consent-based later, bible 5.15) |
| INV-01 | Inventory and assets | Stock items and movements; asset register with location, custodian and condition |
| INV-02 | Procurement and maintenance | Vendors, purchase requests with approval, maintenance requests with status |
| LIB-01 | Library | Catalogue (with ISBN), copies, loans, returns, overdue list, reservations; fines optional, charged through the ledger |
| BRD-01 | Boarding | Houses, rooms and beds, assignments per term, exeat check-out and check-in, house staff, boarding fees through the ledger; incidents recorded as safeguarding cases when that module is active |

Decisions for the founder (recommendations in bold):

- **D-R4-1** Approve ADR 0003: extend the existing plan system, with a registry in code and commercial
  configuration in the database. **Recommended.**
- **D-R4-2** Plan names, boundaries and pricing unit. **Recommended:** Essentials, Professional and Enterprise as in
  ADR 0003 §3, every non-core module purchasable as an add-on, and prices per active student per term available
  next to flat prices (`13` C-01). Prices themselves stay with the founder.
- **D-R4-3** Timetable, insights and Transfer Passport. **Recommended:** keep them in every plan, as today; do not
  reclassify built functionality into paid modules.
- **D-R4-4** Safeguarding in every plan, never sold separately (child protection should not depend on a school's
  budget). **Recommended.** Visitors and pickup in Professional and as an add-on.
- **D-R4-5** Read-only after an add-on ends, for R4 modules only, with a 90-day default window. R3 modules keep
  today's behaviour until a later release. **Recommended.**
- **D-R4-6** Safeguarding access. **Recommended:** a designated-lead permission granted by the Proprietor; EduBridge
  support excluded unless the Proprietor allows it specifically for that period. Wording reviewed with the
  data-protection review (`13` L-04).
- **D-R4-7** Order of operational modules. **Recommended** as in the table above. Boarding is last because few
  private basic schools board. Library and inventory can move to a later release if pilots do not ask for them.
- **D-R4-8** Add-on purchase. **Recommended:** request and invoice (as D-R3-4) until prices are validated; instant
  self-service purchase prepared, not built.

## R5 — Intelligence (approved 2026-11-17)

Design in [ADR 0004](adr/0004-intelligence.md): every figure from our own queries, predictions computed by
explainable rules and labelled, AI used only for words (answers and drafts a person approves), and everything except
the assistant and drafting working with no AI provider. Nothing is built until the founder approves the requirements
and decisions below. The founder approved them, and decisions D-R5-1 to D-R5-8, as recommended on 2026-11-17.

| Phase | Scope | Status |
| --- | --- | --- |
| R5-1 | Command Center (CMD): the school overview, renamed (D-R5-9) | Built |
| R5-2 | Collection forecasting and finance checks (FCT), module `forecasting` | Built; released 2026-11-18 |
| R5-3 | Early-warning indicators and support plans (EWS), module `early_warning` | Built; released 2026-11-18 |
| R5-4 | AI gateway (AIP) at zero operating cost (D-R5-10); then the assistant made dependable (AST) | Built; no real model scored yet |
| R5-5 | AI drafting (DRF), module `ai_drafting`, on the zero-cost gateway (D-R5-10) | Built; released 2026-11-18 |

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| CMD-01 | Financial health | Billed, collected, outstanding, collection rate, arrears by age, collections by week and term, reconciliation status (unmatched Mobile Money, open refunds, closed periods); each figure links to its report and equals it (tested) |
| CMD-02 | Academic health | Results and attendance by term, level and subject; registers and marks outstanding; students with early-warning indicators (count only, links for those allowed) |
| CMD-03 | Enrolment health | Students now, admissions this term (from the pipeline), withdrawals and transfers with reasons, retention from last term, enrolment by term |
| CMD-04 | Operational health | Only for active modules: leave waiting, staff attendance, maintenance open, purchases waiting, overdue exeats, books overdue, pickups refused today, visitors on site |
| CMD-05 | Campus comparison and filters | Year, term, campus and class filters on every section; campus side by side; campus scope applies |
| CMD-06 | Board summary | A printable one-page summary (PDF) of the chosen term, figures only, with the date and filters; nothing fabricated, empty states where there is no data; under 1 s at 2,000 students |
| FCT-01 | Collection forecast | Expected receipts by week to the end of the term: likely and range from the school's past terms, plus plan instalments due; labelled as a forecast; last term's accuracy at the same week shown; "not enough history" without a complete past term |
| FCT-02 | Finance checks | Rule-based flags (duplicate references, voids by one person above a number, receipts outside school hours, Mobile Money unmatched after a day, refunds above an amount, period reopened); each links to its records; reviewed once with a note, kept |
| EWS-01 | Indicators | Rules the school sets (suggested: attendance below 85% over four weeks, 3 absences in a row, average down 10 points from last term, 2 or more subjects below the pass mark); each indicator lists its evidence; recomputed daily and when records change |
| EWS-02 | Teacher review | The class teacher reviews each new indicator: no action needed (with a reason), support plan, or referred to the head teacher; reviews kept; indicators not reviewed in 7 days shown to the head teacher |
| EWS-03 | Support plans | Goal, actions, who, review date and outcome; history kept; visible to the class teacher and academic leads; never to families, students or EduBridge support |
| AIP-01 | One AI gateway | Every AI call through `src/server/ai`: model and effort per task (platform setting), prompt caching, refusal fallback, metering in `ai_usage` (tokens and estimated cost per school, person and task) |
| AIP-02 | Limits | A monthly allowance per school from its plan, checked before each call; a per-person hourly limit; a platform kill switch per task; clear messages when a limit is reached |
| AIP-03 | Privacy | Names sent only when the school allows it; drafts about a child use placeholders filled in on our server; no safeguarding, medical or document data in any AI task |
| AIP-04 | Evaluation set | Questions and draft requests on the seeded synthetic school with expected figures; run on request before any change of model, prompt or tool, with its cost reported |
| AST-01 | Checked answers | Every number in an answer must appear in that question's tool results, or the answer carries a warning and is flagged in the log; sources link to the pages the figures came from; forecasts are named as forecasts |
| AST-02 | More of the school | Tools for staff and HR, transport, inventory, library, boarding, Command Center figures and forecasts, each with the asker's own permissions; never safeguarding |
| DRF-01 | Report-card remarks | Suggested remarks from the child's own scores and attendance, sent without names; the teacher picks, edits or discards; nothing is saved until the teacher saves the remark |
| DRF-02 | Announcements | A draft from a few points and an audience; the person edits and sends through the existing announcement flow |
| DRF-03 | Board report | Prose around the Command Center figures, with every figure inserted by our code; edited and downloaded by the Proprietor |
| DRF-04 | Drafts recorded | Each draft kept with who asked, the task, the model and whether it was used, changed or discarded |

Decisions for the founder (recommendations in bold):

- **D-R5-1** Approve ADR 0004: figures only from our queries, explainable forecasts and indicators, AI only for
  words, one AI gateway. **Recommended.**
- **D-R5-2** Order. **Recommended** as in the table: the three phases that need no AI first (they sell to the
  Proprietor and cost nothing to run), then the AI gateway, then drafting.
- **D-R5-3** Packaging. **Recommended:** Command Center and forecasting in Professional and Enterprise and as an
  add-on; early-warning in Professional and Enterprise (it needs attendance and assessment, which Professional
  has); the assistant and drafting as one add-on with a monthly allowance, included with a smaller allowance in
  Enterprise. The overview and Insights stay in every plan (D-R4-3). Prices stay with the founder.
- **D-R5-4** No predictions about individual families or children: forecasts for the school, level or class only;
  early-warning as rules with evidence, reviewed by a teacher, never shown to families. **Recommended.**
- **D-R5-5** Names to the AI provider: off unless the school allows it (as now), and never for drafts about a child
  (placeholders). **Recommended.**
- **D-R5-6** AI model and cost. **Recommended:** keep `claude-opus-5-5` (today's default) for every AI task at
  first, and measure the cost per question and per draft on the evaluation set before setting allowances and
  prices. Estimate to verify (Claude Opus 5.5 list prices, US$4 per million input tokens, US$20 per million output,
  cached input US$0.20): about US$0.10 to US$0.15 per assistant question with three tool rounds, and about
  US$0.02 to US$0.04 per remark draft, before caching gains. A school asking 300 questions a month would cost about
  US$30 to US$45. A cheaper model per task (Claude Sonnet 5.5 or Claude Haiku 5.5, already selectable) is a choice
  the founder makes after seeing the measured quality on the evaluation set.
- **D-R5-7** Switching AI on in production is a paid service: it stays off until the founder approves it, after the
  data-protection review has looked at the provider's terms, data retention and data location (`13` L-01, L-02).
  **Recommended.**
- **D-R5-8** Early-warning defaults and who sees them: the suggested thresholds in EWS-01, verified with pilot
  schools; class teachers for their own classes and academic leads; never families, students or EduBridge support.
  **Recommended.**
- **D-R5-10** (founder, 2026-11-18) R5-4 approved without a mandatory paid AI service: a provider-agnostic gateway,
  free-tier or local providers first (de-identified data only), configurable flags and limits, and a documented
  path to a paid provider (ADR 0004 §3, revision). D-R5-6 and D-R5-7 still apply to any paid provider.
- **D-R5-9** (founder, 2026-11-18) The overview does the job better than a separate page: it becomes the Command
  Center, in every plan, with the board summary, operations and enrolment movement added; the separate page and
  the `command_center` add-on are dropped. See the as-built note below.

Command Center (R5-1), acceptance criteria written at the start of the phase (module `command_center`):

| ID | Acceptance criteria |
| --- | --- |
| CMD-01a | Money for the chosen term and campus: billed, collected, owed today, collection rate on the school's basis, arrears by age and collections by week, computed by the same services as the overview and fee reports, so each figure equals the report it links to (tested) |
| CMD-01b | Reconciliation status: Mobile Money differences still open, refunds waiting for a decision or payment, and the date the accounts are closed to; each links to its page |
| CMD-02a | Results and attendance term by term (the last six terms that have started): students placed, new students, attendance and lateness, average of published report cards, from the Insights services |
| CMD-02b | For the chosen term, academic work outstanding: classes missing registers in the last two weeks and classes with score sheets not complete (current term) |
| CMD-02c | A class filter narrows the academic section to one class for the chosen term: students, attendance rate, average of published report cards, score sheets complete; money and operations stay school or campus figures, as in the fee reports |
| CMD-03 | Enrolment for the chosen term: students placed by level, admissions (applications received, and enrolled from the pipeline, in the term's dates), students who left in the term's dates by reason (withdrawn, transferred, graduated), and retention: of the students placed in the previous term and not graduated, the share placed again |
| CMD-04 | Operations now, only for modules the school has and tiles the person may open: leave waiting, maintenance open and urgent, purchases waiting, boarders overdue from exeat, library books overdue, pickups refused today, visitors on site |
| CMD-05 | Campuses side by side, for a school with more than one campus and a person who sees every campus: students, billed, collected, collection rate, attendance rate and average result for the chosen term; the term and campus filters apply to every section |
| CMD-06 | A one-page board summary (PDF) of the chosen term and campus: the money, enrolment, results and attendance figures above, with the date and filters, nothing fabricated (empty figures say so); downloading it is audited |
| CMD-07 | Permissions: `command_center.view` (Proprietor, Head teacher, Administrator, Accountant). Each section shows only to roles that see its report (money: fees; results: academic leads; enrolment: every student). The page answers in under 1 s at 2,000 students (`npm run perf:pilot`) |

As built, then changed by the founder on 2026-11-18 (**D-R5-9**): the separate Command Center page was removed
and the school overview (`/s/[school]`) renamed the Command Center, in every plan (core, like the overview it
replaces; module `command_center` is back to `planned` and not sold, which changes D-R5-3 for it). On it: the board
summary download (CMD-06, route `board-summary`), Operations now in place of School details (CMD-04), and under
the students charts the old page's list of students by level in place of the table by level and campus; the People
section is gone. The board summary prints the enrolment movement (CMD-03), the reconciliation status (CMD-01b),
results and attendance, and campuses side by side (CMD-05) for people who see every campus. Dropped with the page: the term-by-term table (Insights has it), the
class filter (CMD-02c) and the `command_center.view` permission; the summary is for people who see the school's
money or every student. Services: `src/server/dashboard/board-summary.ts` (`getMovement`, `getOperationsNow`,
`getBoardSummary`), with Insights' `getTermPoint` for each campus; downloads audited as
`command_center.summary_downloaded`. Operations counts show only to people who see every campus, since those
records have no campus.

Assumptions to verify with pilot schools: what a board summary should hold; that retention leaves graduates out.
Not in R5-1: early-warning counts (R5-3 adds them), forecasts (R5-2), comparisons with other schools, targets
and goals, and scheduled email of the summary.

Collection forecasting and finance checks (R5-2), acceptance criteria written at the start of the phase (module
`forecasting`, pages under Fees):

| ID | Acceptance criteria |
| --- | --- |
| FCT-01a | For a term and campus, money collected so far and expected receipts by week (Monday to Sunday, as "Collected each week") to the end of the term. Collected counts payments by date, voided ones left out, as the payments report |
| FCT-01b | The method (ADR 0004 §2): for each complete past term with fees billed (up to six), the share of its billed fees collected by each day of term. Expected from today = collected so far + this term's billed × the past terms' further share from the same day: the median is "likely", the lowest and highest the range. No model, no new library; pure functions, unit-tested |
| FCT-01c | Payment-plan instalments of active plans due in each remaining week are shown beside the forecast as scheduled amounts, not added to it (past terms' collections already include plan payments) |
| FCT-01d | Labelled as a forecast throughout, with the number of past terms it rests on; last complete term checked the same way at the same day of term (forecast for its end against what was collected, and the difference); "not enough history" when no complete past term had fees billed; an ended term shows what was collected, with no forecast |
| FCT-01e | For the school, a campus or (later) a level only, never a family or a child (D-R5-4) |
| FCT-02a | Finance checks for a term's dates, rule by rule: the same reference on two receipts of one method; three or more voids by one person; receipts recorded by a person between 20:00 and 06:00 school time; Mobile Money differences open over a day; refunds of 1,000 or more in the school's currency; a closed period reopened. Each flag says what it found and links to the records |
| FCT-02b | A flag is reviewed once, with a note (3 to 500 characters), by the Proprietor or Accountant; the review is kept, insert-only, and audited. Mobile Money differences are reviewed where they already are (Mobile Money), not here. A flag whose facts change (another void, another receipt with the reference) is a new flag |
| FCT-03 | Permissions: `forecasting.view` (Proprietor, Head teacher, Accountant) for the forecast; `finance_checks.review` (Proprietor, Accountant) to see and review checks; campus-limited people see their campuses' records, and period reopening only with every campus. Both answer in under 1 s at 2,000 students |

As built (2026-11-18): the method is pure, in `src/lib/forecast.ts`; `src/server/forecasting/forecast.ts` reads the
history with the overview's billed query (`readBilled`) and the payments report's rule; the checks are
`src/server/forecasting/checks.ts`, rules and thresholds in `src/lib/finance-checks.ts`, reviews in
`finance_check_reviews` (migrations 0115 and 0116, insert-only by trigger). Pages `fees/forecast` and `fees/checks`
(tabs under Fees). The weekly forecasts are differences of the cumulative forecast from today, so they add up to the
end-of-term figure. Recording a payment already warns about a repeated reference; the check finds the ones confirmed
anyway. At 1,991 students the checks page answers in 41 ms; the forecast's timing with history at that size is not
yet measured (the demo school has one term). Seeded and demo schools have one term, so they show "not enough
history".

Assumptions to verify with pilot schools: the fixed thresholds above (school settings for them come later); that
a past term's collections (fees and arrears) are a fair guide to this term's. Not in R5-2: forecasts by level,
email alerts for new flags.

Early-warning indicators and support plans (R5-3), acceptance criteria written at the start of the phase (module
`early_warning`, which needs attendance and assessment):

| ID | Acceptance criteria |
| --- | --- |
| EWS-01a | Four rules, each on or off with thresholds the school sets (Proprietor or Head teacher), suggested: attendance below 85% over the last 28 days (at least 5 registers; late counts as attending, as everywhere); 3 or more absences in a row (unexplained absences; excused ones are counted by the attendance rule); report-card average down 10 points or more from the student's previous published card; 2 or more subjects below 50 on the latest published card this term. Changes audited |
| EWS-01b | Indicators are computed from the records whenever they are read, so they follow every change; each lists its evidence (registers, dates, averages, subjects) and the day it was raised, worked out from the records (the first day of the current stretch below the threshold, the day of the last absence that made the run, or the day the card was published) |
| EWS-01c | For students placed in a class this term; the wording is "may need support", never a label or a score; no ranking of children |
| EWS-02a | The class teacher (for their own classes) or the Head teacher reviews an indicator once: no action needed, open a support plan, or refer to the Head teacher, always with a reason (3 to 500 characters). Reviews are kept (insert-only) and audited. A new run of absences, or a new term, is a new indicator |
| EWS-02b | Indicators not reviewed within 7 days of being raised are shown to the Head teacher (and academic leads) as waiting; referrals are listed for the Head teacher, who can open a support plan for the student |
| EWS-03 | Support plans: goal, actions, who is responsible, review date; updates are added, never edited (each with a note and an optional new review date); closed once with an outcome. Overdue reviews are shown. Visible to the student's class teacher and academic leads |
| EWS-04 | Permissions: `early_warning.view` (Proprietor, Head teacher, Administrator; teachers for the classes they are class teacher of), `early_warning.review` (Head teacher; class teachers for their classes), `early_warning.manage` (Proprietor, Head teacher). Never families, students or EduBridge support (in the support exclusions); not in exports or the assistant. The Command Center shows the number waiting for a review. Under 1 s at 2,000 students |

As built (2026-11-18): the rules are pure, in `src/lib/early-warning.ts`; `src/server/early-warning` holds the
indicators (computed from the records on every read, so there is no indicator table: the day each was raised is
worked out from the records), reviews, support plans and the rules (migrations 0117 and 0118: reviews and plan
updates insert-only, a plan closed once by trigger). Pages `/s/[school]/early-warning` (Indicators, Support plans,
Rules), under Academics. The Command Center's Operations now shows "Early-warning reviews waiting" for academic
leads. At 1,991 students the page answers in 286 ms and the Command Center in 577 ms. The Proprietor and
Administrator read indicators and plans but do not review (ADR 0004 §5).

Assumptions to verify with pilot schools: the suggested thresholds (D-R5-8); that excused absences belong in the
attendance rule. Not in R5-3: alerts by SMS or email, indicators from behaviour or fees, parent involvement in plans.

AI gateway (R5-4, first part), acceptance criteria written at the start of the phase, replacing AIP-01 to AIP-03
for this part (D-R5-10). AST-01, AST-02 and the evaluation set (AIP-04) follow in the second part.

| ID | Acceptance criteria |
| --- | --- |
| AIG-01 | Every AI call goes through `src/server/ai`, in a neutral format (messages, tool calls and results); providers are adapters (`openai_compatible` for Ollama and free hosted tiers such as Groq, with `fetch`; `anthropic` kept, with prompt caching of the tool definitions). Provider, model, address and key are platform settings; switching changes no feature code. No new dependency, no billing account |
| AIG-02 | Feature flags: a global AI switch and one per task (the assistant now; drafting later), set by platform staff; then the school's plan module and the Proprietor's switch; then the person's permission. With AI off or not configured, every page works and AI features say so |
| AIG-03 | Limits, checked before every call: platform tokens a month; school tokens a month (a platform default, overridable per school); per person, requests a minute and an hour and tokens a day; output tokens per call. A limit reached, or the provider's quota or rate limit (HTTP 429), gives a plain message with when it resets; timeouts and provider errors say the AI is unavailable |
| AIG-04 | Usage: every call recorded in `ai_usage` (school, person, task, provider, model, input, cached and output tokens, estimated cost, zero for free and local providers, outcome, time taken), insert-only; this month's use shown to platform staff (all schools) and to the Proprietor (their school). Settings changes are audited |
| AIG-05 | Privacy: free and local providers are de-identified only, whatever the school's setting: names, admission numbers, phone numbers, email addresses and the school's name are replaced by references before anything is sent, and put back on our server. Only a paid provider can be marked approved for identifiable data (after the D-R5-7 review); then the school's consent to share names applies. No safeguarding, medical or document data in any task |

As built (2026-11-18): `src/server/ai` holds the neutral types, the adapters (`providers/openai-compatible.ts` with
`fetch`, `providers/anthropic.ts` with the SDK and cached tool definitions), the configuration (`config.ts`), the
gateway (`gateway.ts`: flags, limits, throttling per request, a 45-second timeout, usage and plain messages) and
platform staff's settings (`admin.ts`); the provider catalogue and limits are in `src/lib/ai-providers.ts`. The
assistant runs on it: `src/server/assistant/model.ts` is gone, and identifying keys (names, admission numbers,
phone, email) and the school's name are withheld from any provider not approved for identifiable data. Migrations
0119 and 0120; the old `platform_settings.assistant_enabled` became the assistant's task flag, and the founder
approved dropping the old column (migration 0122, 2026-11-18). Admin, Integrations has the AI and AI limits sections; a school's own allowance is on
its page under Schools; the Proprietor sees this month's use under Settings, Assistant. AI stays off and the provider
"none" until platform staff choose one. To try it at no cost: run Ollama with a tool-capable model and choose it, or
add a Groq free-tier key (with zero data retention turned on in Groq's data controls).

Assistant made dependable (R5-4, second part), acceptance criteria written at the start of the part:

| ID | Acceptance criteria |
| --- | --- |
| AST-01a | Every figure in an answer (amounts, percentages, counts) is checked against the figures in that question's tool results. Figures that do not appear there are listed with the answer as "could not be checked against the records" and kept with the question in the log, where leaders can see which answers were flagged. Dates and the term's name do not count as figures |
| AST-01b | Sources are links to the pages the figures came from |
| AST-01c | An answer that uses the collection forecast says it is a forecast; if the model did not, our code adds the sentence |
| AST-02 | New tools, each calling the page's own service with the asker's context, so role, plan module and campus scope apply: the Command Center (money, enrolment movement, operations now), the collection forecast, staff and leave (counts and names, never leave reasons or which kind of leave a named person is on), transport, inventory (low stock, repairs, purchases waiting), library (books, loans, overdue), boarding (houses, beds, exeats). Never safeguarding, early warning or support plans. New identifying keys are withheld from unapproved providers like names |
| AIP-04 | An evaluation set: questions about the seeded synthetic school whose expected figures our code works out from the same services, scored on whether the answer contains them and has no unchecked figures, with tokens and estimated cost per question. Run on request (`npm run ai:eval`, with the provider and model as arguments, so trying a free or local model changes no platform setting); never in CI, since a run calls the provider. It writes nothing to the school's question log |

As built (2026-11-18): the figure check is pure, in `src/lib/answer-check.ts`; `runAssistant` in
`src/server/assistant/service.ts` runs one question and checks it (figures the person typed in the question count as
theirs), and `askAssistant` logs it with `unchecked_figures` (migration 0121). The assistant page shows unchecked
figures with the answer and in the log, and sources as links. Seven tools added in `src/server/assistant/tools.ts`;
a section a role may not see says so instead of failing the tool. The evaluation set is `src/server/ai/eval.ts`
(nine questions) with `scripts/ai-eval.ts`. Tried against the local Ollama install on 2026-11-18: its only model
(dolphin3:8b) cannot use tools, so the provider refused and the runner reported it at no cost; a tool-capable model
(for example `llama3.1:8b`) is needed for a real score.

AI drafting (R5-5), acceptance criteria written at the start of the phase (module `ai_drafting`; every call through
the gateway, with its flags, limits and usage):

| ID | Acceptance criteria |
| --- | --- |
| DRF-01 | Report-card remarks: on a draft report card, three suggested class-teacher remarks from the child's subject totals and grades, average and register attendance. No name, admission number or school name is sent (the model writes "{first name}", filled in on our server, D-R5-5). The teacher picks one into the remark, edits it, or discards them; nothing is saved until the teacher saves the report card |
| DRF-02 | Announcements: a title and message drafted from a few points the person writes and the audience chosen; filled into the announcement form, where the person edits it and posts it through the existing flow (with its audience, SMS cost and scheduling). The points are sent as written, as questions to the assistant are |
| DRF-03 | Board report: prose around the Command Center figures for a term (and campus). The model writes placeholders such as {{billed}}; our code puts the figures in, so every figure is ours; any figure the model wrote itself is flagged. The Proprietor edits the text and downloads it with the board summary as one PDF |
| DRF-04 | Every draft is kept (`ai_drafts`, never deleted) with who asked, the task, the provider and model, what was sent (no names), the draft, and its outcome, decided once: used as drafted, changed, or discarded |
| DRF-05 | Permissions: `drafting.use` for staff, and only for work they may already do (remarks: entering report-card remarks for that class; announcements: sending them); the board report for the Proprietor (`drafting.board_report`). Each task has its own switch (Admin, Integrations). With AI off, over a limit or unavailable, the forms work as before and say why drafting is not available |

As built (2026-11-18): `src/server/drafting/service.ts` (remarks, announcements, board report, outcomes) with pure
helpers in `src/lib/drafting.ts`; drafts in `ai_drafts` (migrations 0123 and 0124: outcome decided once, never
deleted), and three task switches added to the gateway, all off. Remark suggestions are on the report card page,
"Draft it from a few points" in the announcement dialog, and the board report at `/s/[school]/board-report` (linked
from the Command Center for the Proprietor), downloaded through `board-summary` by POST with the edited text. Tried
on 2026-11-18 with the local Ollama model (dolphin3:8b, free, nothing leaves the machine) on the seeded school: the
announcement and board report drafts were usable, every board figure was ours, and the school was named only by our
code. The board draft once called "owed today, every term" an amount "for this term": the Proprietor's edit is the
check on wording, as intended. Remark suggestions were not tried there.

## Plans and billing (founder, 2026-11-18)

Decided: every module released (stage `general`); plans priced **per active student, shown as size bands**, with a
minimum (the first band); **termly** by default, **yearly** with a discount and **monthly** with a premium; students
counted once a term on a **census day**; the operations modules as **add-ons**; an **SMS allowance** in each plan
with top-ups on the next invoice; request-and-approve for changes (D-R3-4, D-R4-8) until prices are validated. This
settles D-R4-2 and D-R5-3 with the tiers below. The prices are the founder's starting points, changed on Admin, Plans.

| Plan | Modules beyond the core and safeguarding | GH₵ per term: up to 150 / 151–300 / 301–600 / 601–1,000 | SMS a month |
| --- | --- | --- | --- |
| Starter | Parent view, fee reminders, Mobile Money, attendance, report cards | 1,200 / 2,100 / 3,600 / 5,500 | 300 |
| Standard | Starter + admissions, visitors and pickup, Command Center, forecasting, early warning | 1,800 / 3,200 / 5,600 / 8,500 | 800 |
| Premium | Standard + staff and HR, payroll, WhatsApp, assistant, AI drafting | 2,700 / 4,800 / 8,400 / 12,500 | 2,000 |

Add-ons on any plan, per term: transport GH₵450, boarding 750, library 300, inventory 300, staff and HR 400, payroll
400. Above 1,000 students the price is agreed. Yearly: 12% off the terms paid for; monthly: a twelfth of the year's
terms plus 10%.

As built: `src/lib/pricing.ts` (bands, periods, suggested plans); a plan's band prices are copied onto the school
(`tenant_entitlements.price_bands`), so changing a plan never changes schools already on it, and an agreed price
(`price_pesewas`) wins over them; a discount per school (percentage, name, end date). `src/server/billing/auto-invoices.ts`
works out each school's next invoice (the same quote is shown on Settings, Plan and on the school's admin page), takes
the census (`subscription_census`) and issues invoices through the database function
`subscription_issue_automatic_invoice` (migrations 0125–0127): termly and yearly on the census day, monthly on the
first of the month, due after the set days; never for demo schools, a trial covering the period, or a period an invoice
already covers. Reminders go a week before the due date and once after it. Marking an invoice paid moves "paid until"
to the end of its period. SMS top-ups (`sms_top_ups`) raise the month's allowance and are charged once. Admin, Billing
has the invoicing settings (automatic invoices **off** until the prices are final) and the year's revenue; Admin,
Plans has "Add the suggested plans". The seed adds the plans; the demo school is on Premium with the four operations
add-ons. Not yet: prorating, tax lines (VAT to be confirmed by EduBridge's accountant), per-message SMS on automatic
invoices for schools without an allowance (staff invoice those by hand), and self-service plan changes.

## Later releases

R1 pilot (students, guardians, fees, ledger, receipts, parent portal, one payment provider, finance SMS/email),
R2 academics and offline attendance, R3 growth, R4 operations, R5 intelligence. See `01` §4.

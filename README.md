# EduBridge Ghana

A premium, multi-tenant school management and operations platform for international and private
schools in Ghana, with future expansion across Africa. Responsive web app and installable PWA today;
Android and iOS apps later, sharing the same `/api/v1`.

- [Project bible](docs/00-PROJECT-BIBLE.md), [requirements](docs/01-PRODUCT-REQUIREMENTS.md),
  [architecture](docs/02-SOFTWARE-ARCHITECTURE.md), [risks](docs/13-RISKS-AND-ASSUMPTIONS.md)
- [Database](docs/03-DATABASE-DESIGN.md) — implemented tables, tenant isolation, migration workflow
- [Roadmap](docs/11-DEVELOPMENT-ROADMAP.md) — milestones and how the code differs from `02`
- [Status and handoff](docs/HANDOFF.md) — where the project stands and what comes next

## Requirements

Node.js 22+ and PostgreSQL 16 (installed, or run with Docker), on Windows 10/11, macOS or Linux. The commands below work in any shell
(PowerShell, Command Prompt, Terminal, bash) unless marked otherwise.

## Local setup

```bash
npm install
```

### 1. Start PostgreSQL with the EduBridge roles and databases

Choose one option.

**Option A: Docker (recommended on Windows; works on macOS and Linux too).** Install
[Docker Desktop](https://www.docker.com/products/docker-desktop/) (on Windows, keep the default WSL 2 setting)
and start it. Then, in the project folder:

```bash
docker compose up -d --wait
```

This runs PostgreSQL 16 from `compose.yaml` and, on first start, creates the roles and databases from
`scripts/db-bootstrap-local.sql`. Data is kept between restarts. Stop it with `docker compose down`, or delete
all local data with `docker compose down -v`.

If PostgreSQL is already installed and using port 5432, pick another port. In PowerShell:

```powershell
$env:EDUBRIDGE_DB_PORT = "5433"; docker compose up -d --wait
```

Then change `5432` to `5433` in both URLs in `.env.local` (step 2), and run tests with `TEST_DB_HOST` set to
`localhost:5433`.

**Option B: install PostgreSQL 16 yourself.**

macOS / Linux:

```bash
sudo -u postgres psql -f scripts/db-bootstrap-local.sql
```

Windows: install with the [EDB installer](https://www.postgresql.org/download/windows/) (keep port 5432 and note
the `postgres` password you choose), then in PowerShell:

```powershell
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -f scripts\db-bootstrap-local.sql
```

### 2. Create `.env.local`

macOS / Linux:

```bash
cp .env.example .env.local
```

Windows (PowerShell):

```powershell
Copy-Item .env.example .env.local
```

Generate a local `MFA_ENCRYPTION_KEY` (encrypts two-step verification secrets) and paste it into `.env.local`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 3. Migrate, seed and run

The scripts read `.env.local` themselves, so no shell-specific setup is needed:

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run dev
```

In another terminal, run the worker that delivers email and SMS (with retries), settles Mobile Money prompts and finishes report-card print runs:

```bash
npm run worker
```

Without `BREVO_API_KEY` / `ARKESEL_API_KEY`, messages are written to `.dev-mailbox.jsonl` instead of being sent.

Offline registers use a service worker, which is registered only in production builds (`npm run build && npm run start`). In `npm run dev`, registers still keep marks on the device when the connection drops, but pages do not open offline.

Sign in at http://localhost:3000 (staff pages live under `/s/{school}`) with any seeded account, password `edubridge-dev-only`:
`owner@example.test` (proprietor of two schools), `head@` (head teacher), `admin@`, `bursar@` (accountant), `teacher@`, `parent@`, `student@example.test`.
`platform@example.test` is a platform admin (no schools) and requires two-step verification: add the
dev-only secret `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` to an authenticator app. `bursar@` also uses two-step
verification (Kpone Ridge requires it for accountants), with the dev-only secret `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`.
All seeded data is fictional.

## Demo school

The seed is small and made for tests. To show EduBridge to a school, create a demonstration school with a
term's worth of made-up activity (about 300 students, fees, payments, reminders, daily registers, marks and
one class's published report cards; it takes under a minute):

```bash
npm run demo:school
```

It prints the sign-in addresses (`proprietor@demo-academy.demo.test`, `head@`, `admin@`, `accountant@` and
`teacher@`, who is class teacher of Basic 4). Locally the password is `edubridge-dev-only`; elsewhere a
strong one is generated and printed, or pass `--password=...`. Options: `--slug=`, `--name=`, `--students=`
(per class), `--seed=`. It never changes an existing school: run it again with a new `--slug`.

A demo school is labelled on every page, records messages without ever sending them, and is left out of the
parent view (its phone numbers are random and could belong to real people). Two-step verification is off
for its staff, so presenters can switch roles quickly.

### 5-minute demos

Each takes about five minutes on the demo school (`/s/demo-academy`) unless it says otherwise.

1. **Know where the school stands.** Sign in as `proprietor@`. The Overview shows this term's billed and
   collected amounts, the collection rate, what was paid within a week of a reminder, collections by week
   and by method, what is owed and for how long, attendance with the students to follow up, report-card
   progress and enrolment. Every figure opens the report it comes from (the "Collected" figure opens Fees,
   Payments for the same days). For a new school's first steps, sign in as `owner@example.test` and open
   Adenta Hall (seeded empty): the setup guide walks through calendar, classes, staff, students, guardians,
   fees and subjects, and ticks steps off from the school's records.
2. **Take a payment, issue a receipt, prompt Mobile Money.** As `accountant@`, open any student from Fees,
   Owing. Record a cash payment: a numbered receipt (PDF) is issued and the balance updates. Send a Mobile
   Money prompt. With `PAYSTACK_TEST_SECRET_KEY` in `.env.local`, prompts go to Paystack's test mode: use
   the MTN test number `055 123 4987`, which approves at once, then check the status to get the receipt.
   Without it, the mock approves `024 123 4567` (other test numbers decline, time out or pay the wrong
   amount; see `src/server/mobile-money/mock.ts`).
3. **Chase who owes what.** Fees, Owing lists every family that owes, largest first, with their contact and
   payment plan. Filter by class or amount, then send reminders (in the demo school they are recorded, not
   sent; at Kpone Ridge they are written to `.dev-mailbox.jsonl`). Back on the Overview, "Paid after a
   reminder" shows what such reminders brought in.
4. **Show a parent their child's account** (Kpone Ridge seed, since demo schools have no parent sign-in).
   Open `/p/login` in a private window, enter `0245550101`, and take the code from `.dev-mailbox.jsonl`
   (written there a moment after the request). The parent sees balances, receipts, statements, report cards
   and attendance, and under School news the school's announcements and contact details. To post one, sign
   in as `head@example.test` and open Announcements.
5. **Publish report cards.** As `head@`, open Assessment, Basic 4: every mark is in and the cards are
   published. Open Basic 6, which has every mark but is still in draft: review a card, add the head
   teacher's remark and publish the class, then print the class's report cards as one PDF.
6. **Take the register without a connection** (production build: `npm run build && npm run start`). As
   `teacher@`, open Attendance while online, then turn the network off in the browser's developer tools.
   Reload Basic 4's register: it still opens. Mark a few students and save; reconnect and the marks are sent
   by themselves. If the head teacher changed the same mark meanwhile, both are shown and the teacher chooses.

### Plans, billing and export

- **Plans.** As `platform@example.test`, open a school under Admin, Schools: choose what its plan includes
  and its limits (students, campuses, SMS per month), and record its subscription. Staff of that school
  stop seeing a module as soon as it is left out; its data is kept.
- **Billing.** On the same page, issue an invoice (lines are suggested from the price and last month's SMS),
  then record its payment or void it. Admin, Billing shows every school for a month. The school sees its
  plan, SMS usage and invoices under Settings, Plan.
- **Support access.** As `owner@example.test`, open Adenta Hall, Settings, Support access and allow support
  for a few hours. As `platform@example.test`, open Adenta Hall under Admin, Schools and choose "Open the
  school as support". Back as the Proprietor, the same page lists what support opened and changed.
- **Offline.** As `head@example.test`, open Students, Register (works offline), turn the network off in the browser's
  developer tools and register a child: it waits on the device and is registered (with an admission number) when
  the network returns. Score sheets do the same for marks.
- **Transfer Passport.** On a student's page, download the signed learner record and check it at `/verify`. Under
  Students, Transfers, request a child's records from another school; the family consents in the parent view, the
  other school approves, and you enrol the child with their history.
- **Insights and assistant.** Insights shows the school term by term. The assistant answers questions from the same
  records once `ASSISTANT_ENABLED=true` and an Anthropic key are set (a paid service: off by default).
- **API.** `GET /api/v1` lists the routes; sign in a device with `POST /api/v1/auth/token`.
- **Export.** The Proprietor downloads any of the school's records as CSV from Settings, Data export; the
  Accountant can download fee records.

## Checks

| Command             | What it does                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| `npm test`          | Unit tests + integration tests on a disposable `edubridge_test` database   |
| `npm run test:e2e`  | Playwright against a production build (run `npm run build` and seed first) |
| `npm run typecheck` | TypeScript, strict                                                         |
| `npm run lint`      | ESLint (includes the rule keeping `src/server` framework-agnostic)         |
| `npm run format`    | Prettier                                                                   |

CI runs all of these on every pull request. Before the first `npm run test:e2e` on a new machine, install the
browser once with `npx playwright install chromium`. On Windows, clone with Git's default settings:
`.gitattributes` keeps files in LF so formatting checks pass.

## Development status

R0 Foundation is complete; R1 phases A to P and phases Q to U (API, sync, Transfer Passport, insights, assistant) are built, with Paystack in test mode (live payments wait for approval). See the [roadmap](docs/11-DEVELOPMENT-ROADMAP.md).

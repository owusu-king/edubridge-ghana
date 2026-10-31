# EduBridge Ghana

A premium, multi-tenant school management and operations platform for international and private
schools in Ghana, with future expansion across Africa. Responsive web app and installable PWA today;
Android and iOS apps later, sharing the same `/api/v1`.

- [Project bible](docs/00-PROJECT-BIBLE.md), [requirements](docs/01-PRODUCT-REQUIREMENTS.md),
  [architecture](docs/02-SOFTWARE-ARCHITECTURE.md), [risks](docs/13-RISKS-AND-ASSUMPTIONS.md)
- [Database](docs/03-DATABASE-DESIGN.md) — implemented tables, tenant isolation, migration workflow
- [Roadmap](docs/11-DEVELOPMENT-ROADMAP.md) — milestones and how the code differs from `02`

## Requirements

Node.js 22+ and PostgreSQL 16, on Windows 10/11, macOS or Linux. The commands below work in any shell
(PowerShell, Command Prompt, Terminal, bash) unless marked otherwise.

## Local setup

```bash
npm install
```

### 1. Create the local database roles and database (once)

**macOS / Linux:**

```bash
sudo -u postgres psql -f scripts/db-bootstrap-local.sql
```

**Windows:** install PostgreSQL 16 with the [EDB installer](https://www.postgresql.org/download/windows/)
(keep the default port 5432 and note the `postgres` password you choose), then in PowerShell:

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

In another terminal, run the worker that delivers email and SMS (with retries):

```bash
npm run worker
```

Without `BREVO_API_KEY` / `ARKESEL_API_KEY`, messages are written to `.dev-mailbox.jsonl` instead of being sent.

Sign in at http://localhost:3000 (staff pages live under `/s/{school}`) with any seeded account, password `edubridge-dev-only`:
`owner@example.test` (proprietor of two schools), `head@` (head teacher), `admin@`, `bursar@` (accountant), `teacher@`, `parent@`, `student@example.test`.
`platform@example.test` is a platform admin (no schools) and requires two-step verification: add the
dev-only secret `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` to an authenticator app. `bursar@` also uses two-step
verification (Kpone Ridge requires it for accountants), with the dev-only secret `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`.
All seeded data is fictional.

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

R0 Foundation is complete; R1 is in progress (fees: phase C). See the [roadmap](docs/11-DEVELOPMENT-ROADMAP.md).

# EduBridge Ghana

A premium, multi-tenant school management and operations platform for international and private
schools in Ghana, with future expansion across Africa. Responsive web app and installable PWA today;
Android and iOS apps later, sharing the same `/api/v1`.

- [Project bible](docs/00-PROJECT-BIBLE.md), [requirements](docs/01-PRODUCT-REQUIREMENTS.md),
  [architecture](docs/02-SOFTWARE-ARCHITECTURE.md), [risks](docs/13-RISKS-AND-ASSUMPTIONS.md)
- [Database](docs/03-DATABASE-DESIGN.md) — implemented tables, tenant isolation, migration workflow
- [Roadmap](docs/11-DEVELOPMENT-ROADMAP.md) — milestones and how the code differs from `02`

## Requirements

Node.js 22+, PostgreSQL 16.

## Local setup

```bash
npm install
```

Create the local database roles and database (once):

```bash
sudo -u postgres psql -f scripts/db-bootstrap-local.sql
```

```bash
cp .env.example .env.local
```

Generate a local `MFA_ENCRYPTION_KEY` (encrypts two-step verification secrets) and paste it into `.env.local`:

```bash
openssl rand -base64 32
```

Apply migrations and load synthetic data (the scripts read `MIGRATION_DATABASE_URL` from the environment):

```bash
set -a && . ./.env.local && set +a && npm run db:migrate && npm run db:seed
```

```bash
npm run dev
```

In another terminal, run the worker that delivers email and SMS (with retries):

```bash
set -a && . ./.env.local && set +a && npm run worker
```

Without `BREVO_API_KEY` / `ARKESEL_API_KEY`, messages are written to `.dev-mailbox.jsonl` instead of being sent.

Sign in at http://localhost:3000 (staff pages live under `/s/{school}`) with any seeded account, password `edubridge-dev-only`:
`owner@example.test` (two schools), `admin@`, `bursar@`, `teacher@`, `parent@`, `student@example.test`.
`platform@example.test` is a platform admin (no schools) and requires two-step verification: add the
dev-only secret `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` to an authenticator app. All seeded data is fictional.

## Checks

| Command             | What it does                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| `npm test`          | Unit tests + integration tests on a disposable `edubridge_test` database   |
| `npm run test:e2e`  | Playwright against a production build (run `npm run build` and seed first) |
| `npm run typecheck` | TypeScript, strict                                                         |
| `npm run lint`      | ESLint (includes the rule keeping `src/server` framework-agnostic)         |
| `npm run format`    | Prettier                                                                   |

CI runs all of these on every pull request.

## Development status

R0 Foundation, milestone 1. See the [roadmap](docs/11-DEVELOPMENT-ROADMAP.md).

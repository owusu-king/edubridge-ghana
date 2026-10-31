# 02 — Software Architecture Document

| | |
|---|---|
| Status | **Draft — awaiting founder approval** |
| Phase | 0 — Discovery and architecture |
| Related | `01-PRODUCT-REQUIREMENTS.md`, `03-DATABASE-DESIGN.md`, `06-API-DESIGN.md`, `07-SECURITY-AND-PRIVACY.md` |
| Last updated | 2026-10-31 |

---

## 1. Architectural goals

In priority order. When two goals conflict, the higher one wins.

1. **Correctness of money and tenant isolation.** A wrong balance or a cross-school data leak is an existential failure.
2. **Security and privacy** of children's and families' data.
3. **Maintainability** by a small team that may grow. Boring, well-understood technology is preferred.
4. **Low operating cost** at pilot scale, with a clear path to scale without a rewrite.
5. **Performance on low-end Android devices and slow networks.**
6. **Reuse by future native apps.** All business logic lives behind an API that mobile clients can call.

---

## 2. Architecture at a glance

**Style:** a modular monolith in a single TypeScript repository. It is deployed as **three process types built from one codebase**:

```
                    ┌────────────────────────────────────────────┐
  Browser / PWA ───►│  web   (Next.js — UI, SSR, BFF session)    │
                    └───────────────┬────────────────────────────┘
                                    │ typed HTTP client (internal)
  Future RN app ───────────────────►│
  Payment webhooks ────────────────►▼
                    ┌────────────────────────────────────────────┐
                    │  api   (HTTP API /v1 — all business logic) │
                    │   ├─ modules: identity, tenancy, students, │
                    │   │   billing, payments, notifications ... │
                    │   └─ platform: db, auth, audit, jobs, files│
                    └───────┬───────────────────────┬────────────┘
                            │                       │ enqueue (same DB txn)
                            ▼                       ▼
                    ┌──────────────┐        ┌─────────────────────┐
                    │ PostgreSQL   │◄───────│ worker (jobs: bulk  │
                    │ (RLS, PITR)  │        │ invoices, PDFs, SMS,│
                    └──────────────┘        │ reconciliation)     │
                            ▲               └─────────┬───────────┘
                            │                         │
                    ┌──────────────┐        ┌─────────────────────┐
                    │ Object store │        │ External providers: │
                    │ (private,S3) │        │ payments, SMS, email│
                    └──────────────┘        └─────────────────────┘
```

- **`web`** — a Next.js application. It handles rendering, routing, the PWA shell and the session cookie, and holds **no business logic and no database access**. It calls `api`.
- **`api`** — the single source of business rules. It serves the versioned JSON API (`/v1`) used by `web` and, later, by the React Native apps and integrations. It receives payment webhooks.
- **`worker`** — runs background jobs (`03`/`06` describe the job catalogue). It imports the same domain modules as `api`.

In the pilot all three can run on one small host, or on two. They scale independently when needed.

### 2.1 Why not put the API inside Next.js route handlers? **[DECISION D-09]**

Hosting everything in Next.js (route handlers and server actions) is the cheapest option to start, and it is common. We recommend against it for EduBridge:

| Concern | Logic inside Next.js | Separate `api` process |
|---|---|---|
| Native apps need the same logic | Possible, but server actions are not a public API, so we would end up with two paths | One API for every client from day one |
| Row-level security needs a per-request DB transaction with tenant context and a stable connection pool | Awkward on serverless or edge runtimes; connection pooling problems | Long-lived process with a predictable pool |
| Webhooks, long jobs, PDF generation | Serverless time limits; needs a worker anyway | Natural fit |
| Framework churn | Business logic coupled to Next.js release cycles | Domain code is plain TypeScript |
| Cost | Slightly lower | One more small process (~US$5–25/month at pilot scale) |

The extra process is cheap and keeps the most important code framework-independent. The domain modules remain plain TypeScript packages, so this decision can be revisited without rewriting business logic.

---

## 3. Recommended technology stack **[DECISION D-10]**

| Layer | Choice | Rationale | Alternatives considered |
|---|---|---|---|
| Language | **TypeScript (strict)** everywhere | One language across web, API, worker and future React Native | — |
| Runtime | **Node.js LTS** | Mature; supported by every library we need | Bun (younger ecosystem; revisit later) |
| Monorepo | **pnpm workspaces** + Turborepo | Fast, strict dependency isolation, cached builds | Nx (heavier) |
| Web framework | **Next.js (App Router)** + React | SSR for fast first paint on slow devices; mature PWA patterns | Remix / React Router (viable; fewer hiring advantages) |
| Styling | **Tailwind CSS** with design tokens as CSS variables | Enforces the token system; small CSS output | CSS Modules |
| Components | **Radix UI primitives**, with our own styled components in `packages/ui` (the shadcn/ui *approach*: we own the code) | Accessibility handled by Radix; a fully custom visual language with no template look | MUI or Ant Design (too opinionated visually; recognisably "template") |
| Icons | **Lucide** (one library only) | Consistent stroke style; tree-shakeable | — |
| Data tables | **TanStack Table** (headless) | Sorting, filtering, column visibility and selection with our own markup | AG Grid (heavy; licensing) |
| Charts | Lightweight SVG charts (e.g. **visx** or hand-built) | Small bundle; full control over restrained styling | Chart.js / ECharts (heavier) |
| API server | **Fastify** | Fast, mature, schema-first, good plugin model | Hono (excellent, smaller ecosystem); NestJS (heavy abstraction) |
| Validation and contracts | **Zod** schemas in `packages/contracts`, generating **OpenAPI 3.1** | One schema validates input, types clients and documents the API | tRPC (not ideal for third-party or mobile consumers) |
| Database | **PostgreSQL 16+** (managed) | Relational integrity, RLS, transactions, JSONB where justified | — |
| ORM / query | **Drizzle ORM** + **hand-reviewed SQL migrations** | SQL-transparent, simple transaction control for RLS context, no extra engine, typed `numeric`/`bigint` handling | Prisma (good DX; RLS context and raw-SQL control are less direct) — see §3.1 |
| Background jobs | **pg-boss** (PostgreSQL-backed queue) | No Redis needed; **jobs can be enqueued in the same transaction as business writes** (transactional outbox for free) | BullMQ + Redis (add later if throughput requires it) |
| Auth | **Better Auth** (self-hosted library) *or* a thin in-house session module, chosen in a Phase 1 spike | Sessions in our own DB; supports TOTP, phone OTP, organizations, bearer tokens for mobile | Hosted auth such as Clerk or Auth0 (per-MAU cost grows with parents; data residency and lock-in) |
| Password hashing | **Argon2id** | Current OWASP recommendation | bcrypt |
| PDF generation | HTML templates rendered to PDF in the worker (headless Chromium) | One templating system shared with screen design | React-PDF (more limited layout) |
| Object storage | S3-compatible (e.g. Cloudflare R2, AWS S3) | Private buckets, signed URLs, cheap egress (R2) | — |
| Email | Transactional provider with good deliverability (e.g. Postmark, Amazon SES, Resend) | Webhooks for delivery status | — |
| SMS | Ghana-capable aggregator (e.g. Hubtel, mNotify, Arkesel) behind a provider interface | Local sender IDs, cost | Twilio (expensive for Ghana) |
| Testing | **Vitest**, **Testcontainers** (real Postgres), **Playwright** | Real-database tests are essential for RLS and money | Jest |
| Observability | Structured JSON logs (pino) + **Sentry** (errors) + uptime checks; OpenTelemetry-ready | Low cost at pilot scale | Datadog (expensive) |
| CI/CD | **GitHub Actions** | Free tier sufficient initially | — |

### 3.1 ORM decision: Drizzle over Prisma

Both are viable. Drizzle is recommended because:

- **RLS context.** Each request runs inside a transaction that first executes `SELECT set_config('app.tenant_id', $1, true)`. Drizzle exposes the transaction and raw SQL directly, without workarounds.
- **Money types.** We want `bigint` minor units and `numeric` for rates, with explicit control over how they map to TypeScript (`bigint` and string decimals, never `number`).
- **SQL migrations are first-class.** We will review the generated SQL and add RLS policies, triggers and constraints by hand. These would be raw-SQL additions in either tool.
- **Fewer moving parts.** No separate query engine, generation step or runtime binary.

Risk: Drizzle is younger, and its migration tooling has historically been less polished than Prisma's. Mitigation: we treat migrations as plain SQL files under review, and do not rely on automatic "push".

---

## 4. Repository structure

```
edubridge/
├─ apps/
│  ├─ web/                 Next.js app (staff portal, parent portal, platform admin)
│  │   └─ src/app/
│  │       ├─ (staff)/     /s/[school]/...      staff experience
│  │       ├─ (parent)/    /p/...               parent experience (mobile-first)
│  │       └─ (platform)/  /admin/...           EduBridge staff
│  ├─ api/                 Fastify server: HTTP adapters only (routes → module services)
│  └─ worker/              Job runner: registers job handlers from modules
├─ packages/
│  ├─ modules/             Domain modules (business logic; no HTTP, no React)
│  │   ├─ identity/        users, sessions, credentials, MFA
│  │   ├─ tenancy/         tenants, campuses, memberships, entitlements
│  │   ├─ access/          roles, permissions, policy checks
│  │   ├─ academic-structure/  years, terms, levels, classes
│  │   ├─ students/        students, enrollments, documents
│  │   ├─ guardians/       guardians, families, portal links
│  │   ├─ billing/         fee items, structures, invoices, ledger, statements
│  │   ├─ payments/        payment intents, provider adapters, reconciliation
│  │   ├─ notifications/   templates, dispatch, delivery tracking, providers
│  │   ├─ reporting/       read models, aggregates, exports
│  │   ├─ audit/           audit log writer and queries
│  │   └─ platform-admin/  onboarding, subscriptions, support sessions
│  ├─ platform/            Cross-cutting infrastructure
│  │   ├─ db/              Drizzle schema, migrations, tenant-scoped transaction helper
│  │   ├─ jobs/            pg-boss wrapper, job typing, idempotency helpers
│  │   ├─ files/           object storage, signed URLs, virus-scan hook
│  │   ├─ money/           Money type, allocation, formatting (pure, heavily tested)
│  │   ├─ config/          typed environment configuration (validated at boot)
│  │   └─ observability/   logger, error reporting, request context
│  ├─ contracts/           Zod request/response schemas → OpenAPI + typed client
│  ├─ ui/                  Design-system components (Radix + Tailwind tokens)
│  └─ config-*/            Shared tsconfig, eslint, tailwind presets
├─ docs/                   Architecture and product documentation, ADRs in docs/adr/
└─ tooling/                Scripts: seed (synthetic data only), codegen, checks
```

### 4.1 Module rules (enforced by lint)

1. A module exposes a **public API** (`index.ts`) of services and types. Other modules import **only** from that file.
2. **No circular dependencies** between modules. The allowed direction is roughly: `billing → students → academic-structure → tenancy → identity`. `audit` and `platform/*` can be used by everyone.
3. A module owns its tables. Other modules do not query those tables directly; they call the owning module's service. Reporting is the one exception: it may read through **declared read-only views**.
4. Cross-module side effects (for example, "payment confirmed → send receipt") use **domain events written to an outbox table in the same transaction**, processed by the worker. Modules do not call each other's notification code directly.
5. `apps/*` contain adapters only: HTTP routing, auth extraction, serialisation, job registration. Business logic in `apps/` fails code review.

Enforcement uses `eslint-plugin-boundaries` (or `dependency-cruiser`) in CI.

### 4.2 Inside a module

```
billing/
├─ index.ts              public services and types
├─ domain/               pure logic: invoice state machine, allocation, discount rules (no I/O)
├─ services/             use cases: issueInvoice, postPayment, reverseEntry ... (transactional)
├─ repo/                 Drizzle queries for this module's tables
├─ events.ts             domain events emitted (InvoiceIssued, PaymentPosted ...)
├─ jobs.ts               job handlers (bulk invoice generation ...)
├─ permissions.ts        permission keys owned by the module
└─ __tests__/
```

Pure `domain/` code is where most unit tests live. `services/` are tested against a real PostgreSQL instance.

---

## 5. Multi-tenancy model **[DECISION D-11]**

### 5.1 Tenant definition

- **Tenant = one customer school organization.** It is the subscription holder and the data-isolation boundary.
- A tenant has one or more **campuses**. Campus is an authorization dimension *within* a tenant, not an isolation boundary.
- **School groups** that own several separately branded schools are modelled later as a `tenant_group` above tenants (consolidated reporting, shared billing). They are not part of the pilot. The open question is in `01` §12, Q3.

### 5.2 Isolation strategy: shared database, shared schema, `tenant_id` + RLS

| Option | Isolation | Cost / operations | Verdict |
|---|---|---|---|
| Database per tenant | Strongest | High cost; migrations × N; hard cross-tenant platform reporting | Rejected for now; possible later for enterprise customers who pay for it |
| Schema per tenant | Strong | Migrations × N; connection and search-path complexity | Rejected |
| **Shared schema, `tenant_id` column + PostgreSQL RLS** | Strong when done properly | Lowest cost; one migration path | **Chosen** |

**Defence in depth (all are required):**

1. **Every tenant-owned table** has `tenant_id uuid NOT NULL`, and its primary and foreign keys include it: composite FKs `(tenant_id, x_id)`, so a row can never reference another tenant's row, even by a bug.
2. **RLS enabled and forced** on every tenant table. The policy is `tenant_id = current_setting('app.tenant_id')::uuid`.
3. **The application connects as a role that does not own the tables and does not have `BYPASSRLS`.** Migrations run as a separate owner role.
4. **The tenant context is resolved server-side only.** The URL's school slug is a *hint*. The API resolves the slug, verifies the authenticated user's active membership in that tenant, and only then opens a transaction with `set_config('app.tenant_id', ..., true)` (transaction-local, so it cannot leak across pooled connections).
5. **All tenant data access goes through `withTenantTx(ctx, fn)`.** No other code path obtains a database handle for tenant tables, and a lint rule enforces this.
6. **Platform-level operations** (onboarding, cross-tenant billing) use a separate, narrowly scoped `platform` role and code path, are audited, and never serve tenant users.
7. **Automated isolation tests** (see `10`): for every tenant table, tests check that a query under tenant A cannot see, update or reference tenant B's rows. A CI check fails if a tenant table is created without RLS enabled.

### 5.3 Parents who span tenants

`users` are **global** (one login). `guardians` are **per tenant**. A verified `guardian_portal_link` connects a global user to a tenant's guardian record. The parent home lists links, and each child's data is fetched under **that child's tenant context**, using a separate transaction per tenant. One parent session therefore never reads two tenants' data in a single tenant context.

---

## 6. Request lifecycle

```
1. web receives request → reads HttpOnly session cookie
2. web calls api with the session (server-to-server, internal network) or the browser calls api directly (same-site; see 06)
3. api: authenticate session → load user
4. api: resolve tenant from route (/v1/schools/{schoolId}/...) → verify active membership → load roles, permissions, campus scope
5. api: validate input (Zod) → check permission (access module) → check entitlement (tenancy module)
6. api: withTenantTx: set app.tenant_id, app.user_id → run service → write audit + outbox rows in the SAME transaction → commit
7. worker: picks up outbox/jobs → side effects (SMS, email, PDFs) with idempotency keys
8. api: respond with a typed, versioned response; errors use the standard error format (06)
```

Authorization happens in **two layers**: the access module checks the permission and the campus scope (*can this user do this action here?*), and RLS limits *which school's* rows are visible at all. The database does not try to encode fine-grained role logic. RLS handles tenant isolation, and the application layer handles role and campus permissions, which have their own exhaustive tests.

---

## 7. Financial architecture (summary — detail in `03`)

- **Money type:** `{ amountMinor: bigint, currency: 'GHS' | 'USD' | ... }`. A JavaScript `number` is never used for money. Arithmetic lives in `platform/money`, including allocation with largest-remainder rounding, and it is property-tested.
- **Ledger:** every financial effect on a student account is an **append-only `ledger_entry`** (charge, payment, discount, credit note, reversal, refund, write-off). Balances are **derived** from the ledger. Cached balances may exist for speed, but they are rebuilt from the ledger and checked by a nightly consistency job.
- **Immutability:** database triggers reject `UPDATE`/`DELETE` on posted ledger entries, issued invoices and receipts. Corrections are new, linked entries.
- **Idempotency:** every money-moving command (`postPayment`, `issueInvoice`, webhook handling) carries an idempotency key with a unique constraint, so retries are safe.
- **Concurrency:** posting to an account takes a row-level lock on the account (`SELECT ... FOR UPDATE`) inside a `SERIALIZABLE` or carefully locked `READ COMMITTED` transaction, which prevents double allocation.
- **Sequential numbering:** receipt and invoice numbers come from per-tenant counter rows updated in the same transaction. They are gap-tolerant only on rollback, and that behaviour is documented for auditors.
- **Period locks:** postings must carry a date in an open period, enforced in the service and by a constraint trigger.

## 8. Background processing

- **Queue:** pg-boss in the same PostgreSQL database. Jobs are tenant-aware: every job payload carries `tenantId`, and handlers open `withTenantTx`. Jobs never run without a tenant context unless they are explicitly platform jobs.
- **Outbox:** domain events are inserted in the business transaction. A dispatcher turns them into jobs, which gives at-least-once delivery. Handlers are idempotent by design, using keys and unique constraints.
- **Retries:** exponential backoff and a dead-letter state, with alerts on dead letters for payment and notification jobs.
- **Scheduled jobs:** overdue reminders, provider reconciliation, ledger consistency check, session cleanup and retention enforcement.
- **Scale path:** if job throughput outgrows PostgreSQL (unlikely before hundreds of schools), switch the job adapter to BullMQ/Redis. Handlers are written against our own interface, not pg-boss directly.

## 9. Payment integration architecture

```
payments module
├─ PaymentProvider interface
│    initiate(intent) → redirect/USSD prompt/reference
│    verify(reference) → canonical status
│    parseWebhook(headers, rawBody) → verified event | reject
│    refund(...)?   (capability-flagged)
│    listTransactions(range) → for reconciliation
├─ adapters/ paystack | hubtel | mtn-momo | manual
└─ PaymentIntent state machine:
     created → pending → succeeded | failed | expired | (refunded)
```

Rules:

1. **Only `verify()` or a signature-validated webhook followed by `verify()` can move an intent to `succeeded`.** The browser callback URL only shows status. It never changes state.
2. Webhooks: raw-body signature verification, replay protection (event ID unique), handlers that tolerate out-of-order delivery, an immediate 200 response after durable storage of the event, and processing in the worker.
3. On `succeeded`: post a payment ledger entry (idempotent on the provider reference), allocate it, issue a receipt and emit `PaymentPosted`, all in one transaction.
4. Each tenant has its own **provider configuration** (subaccount ID or API keys), stored encrypted (envelope encryption). Settlement goes directly to the school (D-07).
5. **Reconciliation job:** daily, pull the provider's transactions, match them by reference and amount, and flag mismatches (missing locally, missing at the provider, amount differs) for bursar review.
6. Capabilities differ between providers (refund APIs, MoMo networks, settlement timing). The adapter declares its capabilities, and the UI only offers what the configured provider supports.

**Provider selection (D-06), to be decided after a sandbox spike in R1:**

| Criterion | Paystack | Hubtel | Direct MTN MoMo API |
|---|---|---|---|
| Methods | Cards + MoMo (MTN, Telecel, AirtelTigo) | MoMo (all networks) + cards | MTN only |
| Split/subaccount settlement to schools | Supported (subaccounts) | To be verified | No; each school needs its own MTN merchant onboarding |
| Developer experience and docs | Strong | To be evaluated | Variable |
| Fees | To be confirmed with the provider | To be confirmed | To be confirmed |

Our current hypothesis is **Paystack first**, because of its subaccount settlement model and multi-network MoMo coverage. This must be confirmed in sandbox testing and in commercial conversations. Fees and settlement terms change, so they are deliberately not quoted here.

## 10. Notification architecture

- The `notifications` module receives **notification requests** (event type, recipient, tenant, template data, idempotency key), usually from outbox events.
- Pipeline: request → resolve recipient preferences and channel → render template (per tenant, per locale, versioned) → **content-policy check** (no sensitive fields in SMS) → enqueue a send job → provider adapter → delivery status via webhook or polling → history.
- Provider interfaces exist for SMS, email, web push (R3) and WhatsApp (R3). Tenants can have a sender ID per provider.
- **Cost control:** SMS segment count is estimated before bulk sends, per-tenant monthly SMS quotas come from entitlements, and usage is metered for billing.
- **Duplicate prevention:** a unique constraint on `(tenant_id, idempotency_key, recipient, channel)`.

## 11. Files and documents

- Private bucket(s). Object keys are prefixed `tenants/{tenantId}/...` and are never guessable on their own.
- Upload flow: the API issues a pre-signed `PUT` with a content-type and size limit. After upload, a worker job validates the type (magic bytes) and runs a scan hook (malware scanning is planned; basic type validation comes first). Only then is the file marked `available`.
- Download: the API checks permission, then issues a **short-lived** pre-signed `GET` (≤ 5 minutes). The access is audit-logged for sensitive document types.
- Generated documents (receipts, statements, report cards) are stored with a content hash, so re-generation is detectable.

## 12. Frontend architecture

- **Three experiences in one Next.js app** with separate route groups and layouts: staff (`/s/{school}`), parent (`/p`) and platform (`/admin`). The parent bundle is kept independent and minimal. It does not load staff-only libraries such as tables and charts.
- **Server Components by default.** Client components only for interactivity. Data fetching goes through the generated typed API client.
- **Forms:** React Hook Form + Zod schemas from `packages/contracts`. The same schemas validate on the server.
- **State:** server state via TanStack Query where client-side fetching is needed; no global client state store unless proven necessary.
- **Design system:** tokens → Tailwind config → `packages/ui` components. Pages may not introduce new colours, spacing values or one-off components (lint plus review). Detail in `08-DESIGN-SYSTEM.md`.
- **PWA:** web app manifest, a service worker (Serwist or Workbox) for the app shell, and IndexedDB for the offline attendance queue (R2). Detail in `09`.

## 13. Environments and deployment

| Environment | Purpose | Data |
|---|---|---|
| Local | Development (Docker Compose: Postgres, object-store emulator, mail catcher) | Synthetic seed only |
| CI | Automated tests with ephemeral Postgres (Testcontainers) | Synthetic |
| Staging | Pre-release verification; provider **sandboxes** | Synthetic only, never copied from production |
| Production | Live schools | Real; access restricted and audited |

**Hosting (provisional — costed in `12`):** a managed container platform (e.g. Render, Railway, Fly.io, or AWS/GCP managed services) plus managed PostgreSQL with point-in-time recovery, in a **European region** (London or Frankfurt) for latency to West Africa and mature compliance. AWS Cape Town (`af-south-1`) should be evaluated for latency and for any data-residency expectations from schools. Act 843 cross-border transfer obligations require legal review (`13`). **[DECISION D-12]**

Releases: GitHub Actions → build one container image → deploy to staging → smoke tests → manual promotion to production. Migrations run as a separate, reviewed step before the new version starts, and must be backward-compatible (expand/contract).

## 14. Cross-cutting concerns

| Concern | Approach |
|---|---|
| Configuration | `platform/config` validates all environment variables at boot with Zod; the app refuses to start on invalid config; no secrets in the repo; `.env.example` documents keys |
| Secrets | Platform secret store; per-tenant provider credentials encrypted at rest with a KMS-held key (envelope encryption) |
| Errors | Typed domain errors → mapped to the standard API error format; no stack traces to clients; Sentry with PII scrubbing |
| Logging | JSON logs with `requestId`, `tenantId`, `userId`; **no names, phone numbers, emails or amounts tied to identities in logs** |
| Time | All timestamps stored as `timestamptz` (UTC); tenant timezone used for display and for "business date" calculations (due dates, period locks) |
| IDs | UUIDv7 primary keys (time-ordered, index-friendly, not enumerable); human-readable numbers (admission, invoice, receipt) are separate per-tenant sequences |
| Internationalisation | Strings externalised from the start; `Intl` APIs for number, currency and date formatting by tenant locale (`en-GH` default) |
| Rate limiting | Per IP and per user on auth endpoints; per tenant on bulk and SMS operations; stored in Postgres initially (Redis later if needed) |

## 15. Scalability path

| Stage | Indicative scale | Changes |
|---|---|---|
| Pilot | 1–5 schools, < 5k students | One small instance per process; one Postgres instance |
| Early commercial | 20–100 schools, < 60k students | Horizontal `api`/`worker` instances; Postgres vertical scale + read replica for reporting |
| Growth | 100–500+ schools | Redis for queue and rate limiting; dedicated reporting replica or materialised read models; CDN; consider dedicated databases for enterprise tenants |

Nothing in the pilot design blocks these steps.

## 16. Architecture Decision Records

Significant decisions are recorded as ADRs in `docs/adr/NNNN-title.md` (context, decision, consequences). The initial ADRs, created when the founder approves this document:

| ADR | Decision |
|---|---|
| 0001 | Modular monolith with separate web, api and worker processes (D-09) |
| 0002 | Technology stack (D-10) |
| 0003 | Shared-schema multi-tenancy with RLS (D-11) |
| 0004 | Append-only ledger and integer minor-unit money |
| 0005 | PostgreSQL-backed job queue with transactional outbox |
| 0006 | Hosting region and provider (D-12) |

## 17. Decisions requiring approval

| ID | Decision | Recommendation |
|---|---|---|
| D-09 | Separate `api` process instead of business logic in Next.js | Approve |
| D-10 | Stack in §3 (notably Drizzle, Fastify, pg-boss, Radix-based custom UI) | Approve; the auth library is decided in a Phase 1 spike |
| D-11 | Tenant = school; shared schema + RLS + composite FKs | Approve |
| D-12 | Hosting region: Europe (London/Frankfurt) vs Cape Town | Decide after legal input and a latency test from Accra |

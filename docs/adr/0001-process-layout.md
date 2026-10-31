# ADR 0001 — Process layout (D-09)

| | |
|---|---|
| Status | **Accepted** by the founder, 2026-10-31 |
| Supersedes | `02-SOFTWARE-ARCHITECTURE.md` §2.1 recommendation (separate Fastify `api`) |

## Context

`02` proposed three processes — Next.js `web` (no database access), Fastify `api`, and a `worker` — in a
pnpm/Turborepo monorepo. Its reasons: one API for web and mobile, a long-lived process for RLS
connection pooling, a home for webhooks and long jobs, and business logic decoupled from Next.js.

## Decision

For the pilot, one Next.js application plus a worker:

1. **`web`**: the Next.js app, deployed as a **long-running Node.js server** (not serverless or edge),
   which gives a stable PostgreSQL pool for `withTenant` transactions.
2. **Business logic lives in `src/server`.** ESLint forbids Next.js and React imports there. Pages,
   server actions and `/api/v1` route handlers are thin adapters that call the same service functions.
3. **`/api/v1` is the public contract** for mobile apps and integrations, authenticated with bearer
   tokens. Server actions are web-only conveniences and never hold logic of their own.
4. **`worker`** (added with the first background job): a second Node process built from the same
   repository, importing `src/server` and running pg-boss with the transactional outbox (`02` §8).
   Payment webhooks are stored durably by a route handler and processed by the worker.

## Consequences

- One deployable fewer, one language runtime, no internal HTTP hop or generated client during the pilot.
- Business logic stays framework-independent, so extracting `src/server` into `packages/modules` behind
  a separate API process stays a relocation, not a rewrite. Revisit if Next.js hosting constraints, team
  growth or API load make the split worthwhile.
- Single repository, no monorepo tooling until there is a second package to share.

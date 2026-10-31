# 11 — Development Roadmap

|         |                                                                                 |
| ------- | ------------------------------------------------------------------------------- |
| Related | `01-PRODUCT-REQUIREMENTS.md` §4 (releases R0–R5), `02-SOFTWARE-ARCHITECTURE.md` |

Small, verified milestones. Each ends with passing tests, type checks, lint and a reviewed pull request.

## R0 — Foundation

| #   | Milestone                                                                                                                            | Requirements                                             | Status              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------- |
| 1   | Project foundation, design system, app shell, PostgreSQL + forced RLS, sessions, RBAC, audit log, CI                                 | TEN-02, IAM-04, IAM-05 (no campus yet), IAM-08 (partial) | **Done**, in review |
| 2   | Platform admin: create school (TEN-01), entitlements (TEN-05); campuses (TEN-03) and campus-scoped permissions                       | TEN-01, TEN-03, TEN-05                                   | Next                |
| 3   | Member management: invite, assign roles, deactivate with immediate session revocation, audit log view                                | IAM-07, IAM-08                                           |                     |
| 4   | Account security: password reset (IAM-03), TOTP MFA required for owner/bursar/platform admin (IAM-06), phone-number sign-in (IAM-01) | IAM-01, IAM-03, IAM-06                                   |                     |
| 5   | Background jobs (pg-boss + outbox), structured logging, error monitoring hooks                                                       | `02` §8, §14                                             |                     |

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
| Parent access       | Guardians per tenant, linked to global users via `guardian_portal_link`; parent home at `/p` | `parent` and `student` exist as membership roles, but nothing uses them yet                                                                            | Replace them with portal links in R1 (students/guardians). No data depends on them                                                                  |
| Composite FKs       | `(tenant_id, x_id)` between tenant tables                                                    | Not needed yet: current tenant tables only reference global tables                                                                                     | Applies from the first tenant-to-tenant reference                                                                                                   |
| Testcontainers      | Ephemeral Postgres per test run                                                              | Disposable `edubridge_test` database on a local or CI Postgres service                                                                                 | Same isolation guarantee; no Docker needed                                                                                                          |

## Later releases

R1 pilot (students, guardians, fees, ledger, receipts, parent portal, one payment provider, finance SMS/email),
R2 academics and offline attendance, R3 growth, R4 operations, R5 intelligence. See `01` §4.

# 03 — Database Design

|         |                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------- |
| Status  | **Implemented tables only** (R0 milestone 1). Entities for later releases are added here as they are built. |
| Related | `02-SOFTWARE-ARCHITECTURE.md` §5 (tenancy), §7 (money)                                                      |

PostgreSQL 16. Schema in `src/server/db/schema.ts`; migrations are reviewed SQL files in `drizzle/`.

## Roles

| Role              | Used by                     | Privileges                                                        |
| ----------------- | --------------------------- | ----------------------------------------------------------------- |
| `edubridge_owner` | migrations, seed, operators | Owns all objects. Still subject to RLS on forced tables.          |
| `edubridge_app`   | the running application     | Explicit grants only; cannot bypass RLS; no DELETE on audit data. |

## Tables

| Table            | Scope  | Notes                                                                                                                                                               |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`        | global | Schools. Readable by slug; the app may only update the current tenant's name, timezone and `mfa_required_roles` (two-step policy).                                                                              |
| `users`          | global | Identities. One user can belong to several schools. `citext` email; optional E.164 `phone`, stored only once verified by SMS (unique).                                                                                                 |
| `sessions`       | global | `id` = SHA-256 of the session token.                                                                                                                                |
| `login_attempts` | global | Failed sign-ins for throttling. Safe to purge rows older than 15 minutes.                                                                                           |
| `user_mfa`, `mfa_recovery_codes`, `mfa_challenges` | global | TOTP seed sealed with AES-256-GCM (`MFA_ENCRYPTION_KEY`); last accepted step stored to block replays; recovery codes and challenge tokens stored as SHA-256. |
| `notification_outbox` | global | Email/SMS written in the business transaction; claimed with `FOR UPDATE SKIP LOCKED`; retried with backoff (5 attempts); payload cleared after sending or giving up. |
| `phone_verifications` | global | 6-digit SMS codes (hashed with the verification id), 10 minutes, 5 attempts, 3 per user per hour. |
| `password_resets` | global | 30-minute, single-use, hashed tokens; 3 requests per account and 20 per IP per hour. |
| `memberships`    | tenant | User ↔ school with `roles text[]` (validated by a check constraint). Never deleted by the app; suspend. A user can also see their own memberships in other schools. |
| `academic_years`, `terms` | tenant | School-local `date` columns. `EXCLUDE USING gist` blocks overlapping years/terms per school (`btree_gist`); a partial unique index allows one current term per school; terms reference years by composite FK. |
| `audit_events`   | tenant | Append-only: the app role has INSERT and SELECT only.                                                                                                               |

## Tenant context

```ts
await withTenant(db(), { tenantId, userId }, async (tx) => {
  /* queries */
});
```

RLS policies compare `tenant_id` with `app_current_tenant_id()`, which reads the transaction-local
setting. Outside `withTenant`, tenant tables return nothing.

## Adding a tenant-owned table (checklist)

1. Add `tenant_id uuid not null references tenants(id)` and index queries that filter by it.
2. `npm run db:generate -- --name <change>` to create the table migration.
3. In a custom migration (`npx drizzle-kit generate --custom --name <change>_rls`):
   `ENABLE` + `FORCE ROW LEVEL SECURITY`, policies using `app_current_tenant_id()`, and only the
   grants the app needs for `edubridge_app`.
4. Run `npm test`; the isolation suite fails if RLS is missing.

## Conventions (from `02`)

- Money: `bigint` minor units + ISO 4217 code; append-only ledger; triggers block mutation of posted entries.
- Timestamps: `timestamptz`, displayed in the school's time zone.
- Tenant tables referencing other tenant tables use composite FKs `(tenant_id, x_id)`.

## Workflow

- Generate: `npm run db:generate -- --name <change>` (never edit an applied migration).
- Apply: `npm run db:migrate` (uses `MIGRATION_DATABASE_URL`).
- Destructive changes (drops, type narrowing) require product-owner approval and a backfill plan.

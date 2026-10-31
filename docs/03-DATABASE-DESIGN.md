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
| `tenants`        | global | Schools. Readable by slug; the app may only update the current tenant's name/timezone.                                                                              |
| `users`          | global | Identities. One user can belong to several schools. `citext` email.                                                                                                 |
| `sessions`       | global | `id` = SHA-256 of the session token.                                                                                                                                |
| `login_attempts` | global | Failed sign-ins for throttling. Safe to purge rows older than 15 minutes.                                                                                           |
| `memberships`    | tenant | User ↔ school with `roles text[]` (validated by a check constraint). Never deleted by the app; suspend. A user can also see their own memberships in other schools. |
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

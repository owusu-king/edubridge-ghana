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
| `levels`, `classes` | tenant | Levels in promotion order with a stage (creche … jhs). Classes reference level, campus and optional class teacher by composite FKs (`(tenant_id, x_id)`); unique name per campus; archived, never deleted. |
| `students`, `enrolments`, `tenant_counters` | tenant | Minimal student data (names, sex, optional date of birth); admission number unique per school, auto-numbered from a per-school counter that skips numbers in use. One class per student per term (composite FKs to student, term, class). Teachers see only their classes' students. |
| `guardians`, `student_guardians` | tenant | One guardian per phone number per school (partial unique index), so siblings share guardians; phone or email required (E.164 check). Links carry relationship and a primary contact flag (one per student, partial unique index). |
| `fee_items`, `fee_structure_lines` | tenant | Fee items (unique name per school, archived, never deleted). Structure lines: amount in integer pesewas (`bigint`, check 0 – 1,000,000,000) per term, item and level, with an optional class override; `UNIQUE NULLS NOT DISTINCT (term, item, level, class)`. Billing will copy amounts into the ledger, so structure edits never change past bills. |
| `ledger_entries` | tenant | Append-only fee accounts: the app role has INSERT and SELECT only, and triggers refuse UPDATE, DELETE and TRUNCATE for every role. Signed integer pesewas (charges positive; payments and discounts negative; the balance is the sum), with a check tying sign to kind. A reversal must exactly negate one non-reversal entry of the same student (trigger) and each entry is reversed at most once (unique). `UNIQUE (tenant, student, billing_key)` makes term billing idempotent; `entry_number` (identity) orders statements. |
| `payments`, `payment_voids` | tenant | Insert-only (grants and triggers, as for the ledger). Receipt numbers `R000001…` unique per school, allocated from `tenant_counters` inside the payment transaction (no gaps); `UNIQUE (tenant, idempotency_key)` makes a double-submitted form record once. Each payment has exactly one ledger entry (partial unique index; a trigger checks student and amount). A void is a `payment_voids` row plus a reversal of that entry. |
| `fee_concessions` | tenant | Per-student scholarship or discount: basis points (1–10000) of one item or every item, or a fixed pesewa amount off one item (checks enforce exactly one kind). Can be ended, never deleted. Billing adds `discount` ledger entries keyed `discount:<concession>:term:<term>:item:<item>`, capped at the live charge. |
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

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
| `guardians`, `student_guardians` | tenant | One guardian per phone number per school (partial unique index), so siblings share guardians; phone or email required (E.164 check). Links carry relationship and a primary contact flag (one per student, partial unique index). `portal_blocked_at`/`portal_blocked_by_user_id` stop a guardian using the parent view (set and cleared together). A second SELECT policy shows guardian rows whose phone equals `app.parent_phone`, so parent sign-in can find the schools that have a number on file (migration 0039). |
| `fee_items`, `fee_structure_lines` | tenant | Fee items (unique name per school, archived, never deleted). Structure lines: amount in integer pesewas (`bigint`, check 0 – 1,000,000,000) per term, item and level, with an optional class override; `UNIQUE NULLS NOT DISTINCT (term, item, level, class)`. Billing will copy amounts into the ledger, so structure edits never change past bills. |
| `ledger_entries` | tenant | Append-only fee accounts: the app role has INSERT and SELECT only, and triggers refuse UPDATE, DELETE and TRUNCATE for every role. Signed integer pesewas (charges positive; payments and discounts negative; the balance is the sum), with a check tying sign to kind. A reversal must exactly negate one non-reversal entry of the same student (trigger) and each entry is reversed at most once (unique). `UNIQUE (tenant, student, billing_key)` makes term billing idempotent; `entry_number` (identity) orders statements. |
| `payments`, `payment_voids` | tenant | Insert-only (grants and triggers, as for the ledger). Receipt numbers `R000001…` unique per school, allocated from `tenant_counters` inside the payment transaction (no gaps); `UNIQUE (tenant, idempotency_key)` makes a double-submitted form record once. Each payment has exactly one ledger entry (partial unique index; a trigger checks student and amount). A void is a `payment_voids` row plus a reversal of that entry. |
| `fee_concessions` | tenant | Per-student scholarship or discount: basis points (1–10000) of one item or every item, or a fixed pesewa amount off one item (checks enforce exactly one kind). Can be ended, never deleted. Billing adds `discount` ledger entries keyed `discount:<concession>:term:<term>:item:<item>`, capped at the live charge. |
| `payment_plans`, `payment_plan_instalments` | tenant | Instalment schedule per student (one active, partial unique index); cancelled, never edited; instalments insert-only. Progress is computed from payments (not voided) recorded after the plan was created; the ledger is not touched. |
| `mobile_money_requests` | tenant | One row per Mobile Money prompt: provider, network, E.164 phone, amount (GHS only) and an idempotency key (unique per school). One pending prompt per student (partial unique index). The app may UPDATE, but a trigger keeps what was asked for unchanged, sets the provider reference once and the outcome once (only `pending` and `expired` can still change; never back to pending), and refuses DELETE and TRUNCATE. `successful` requires `payment_id`, and a trigger checks that payment is Mobile Money for the same student and amount. |
| `mobile_money_callbacks` | tenant | Provider callbacks, stored before processing: request id and/or provider reference, SHA-256 of the body (unique per school and provider, so retries are stored once; the raw body is not kept), attempts, and the result once processed. The app may only update `attempts`, `processed_at` and `result`; a processed row cannot change; no DELETE or TRUNCATE. Requests also carry a one-time review (`reviewed_at`, `reviewed_by_user_id`, `review_note`), allowed only on `needs_review` and set once (check and trigger). |
| `parent_sign_in_codes` | global | Parent SMS codes (hashed with the request id), 10 minutes, 5 attempts; `tenant_ids` are the schools that had the number (empty: unknown number, no SMS). Used for limits per number (3 per 15 minutes, 10 a day), per network address (30 an hour) and per school (300 an hour). Only attempts and consumption can change; purged after 2 days. |
| `parent_sessions` | global | Parent sessions: `id` = SHA-256 of the token, the verified phone, 30 days renewed while in use. No tenant: what a parent sees is worked out per request from each school's guardians. |
| `balance_links` | tenant | Read-only links to one student's balance sent in fee reminders: student, guardian, recipient, token hash, 7-day expiry. Insert-only; readable in the tenant or by presenting the token (`app.balance_link_token_hash`). Valid only while the guardian still has that number, is linked to the student and is not blocked. |
| `fee_reminders` | tenant | SMS fee reminders sent: student, guardian, recipient (E.164), school day, balance at the time (also in the message), sender. Insert-only (grants and triggers); `UNIQUE (tenant, student, channel, sent_on)` allows one a day. The message itself is a `notification_outbox` row queued in the same transaction. |
| `subjects`, `level_subjects` | tenant | Subjects a school teaches (name unique per school) and the levels that take each, with report-card order. Taking a subject off a level keeps its marks. |
| `assessment_schemes` | tenant | One per term: the parts of a subject's mark (`components` JSON: key, name, weight %, out of; weights add up to 100) and whether report cards show positions. Saved by the school or by the first mark; until then the previous term's or the defaults apply. Fixed while any report card of the term is published. |
| `grading_scales` | tenant | A school's grade bands for a stage (JSON: lowest whole mark, grade, remark). No row: the stage's defaults. |
| `assessment_scores` | tenant | One mark per term, student, subject and part, in integer tenths (37.5 → 375); cleared marks are deleted. A trigger refuses insert, update or delete while the student's report card for the term is published. Changes are audited with old and new marks. |
| `report_cards` | tenant | One per term and student: attitude, conduct, interest, days present/open (by hand until attendance), class and head teacher remarks; on publishing, `snapshot` (JSON) freezes everything the card shows. A trigger refuses any change to a published card except withdrawal to draft, which clears the snapshot (check). No DELETE. |
| `report_card_batches`, `report_card_files` | tenant | Bulk print runs: classes, status, attempts and a lease (`locked_until`) so one worker prints a run at a time and a crash resumes after the last class; one PDF per class (`bytea`, SHA-256, size). Removed after 7 days. Move the files to object storage when schools print often. |
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

import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** Case-insensitive text (requires the `citext` extension, enabled in the first migration). */
const citext = customType<{ data: string }>({ dataType: () => "citext" });

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * A school (tenant). Global table: resolved by slug before a tenant context exists.
 * Tenant-owned data lives in tables with a `tenant_id` column protected by row-level security.
 */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: citext("slug").notNull().unique(),
    name: text("name").notNull(),
    countryCode: text("country_code").notNull().default("GH"),
    timezone: text("timezone").notNull().default("Africa/Accra"),
    currencyCode: text("currency_code").notNull().default("GHS"),
    status: text("status", { enum: ["active", "suspended"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    check("tenants_slug_format", sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'`),
    check("tenants_country_code_format", sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check("tenants_currency_code_format", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
  ],
);

/** A person's global identity. One user may belong to several schools (e.g. a parent or visiting teacher). */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: citext("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  status: text("status", { enum: ["active", "disabled"] })
    .notNull()
    .default("active"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  ...timestamps,
});

/** Server-side sessions. Only the SHA-256 hash of the token is stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ipAddress: inet("ip_address"),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

/** Failed sign-in attempts, used for throttling. Rows older than the window can be purged. */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: citext("email").notNull(),
    ipAddress: inet("ip_address"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("login_attempts_email_idx").on(t.email, t.attemptedAt),
    index("login_attempts_ip_idx").on(t.ipAddress, t.attemptedAt),
  ],
);

/** A user's access to one school, with that school's roles. Protected by row-level security. */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    roles: text("roles").array().notNull(),
    status: text("status", { enum: ["active", "suspended"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("memberships_tenant_user_unique").on(t.tenantId, t.userId),
    index("memberships_user_id_idx").on(t.userId),
    check("memberships_roles_not_empty", sql`cardinality(${t.roles}) > 0`),
    check(
      "memberships_roles_valid",
      sql`${t.roles} <@ ARRAY['owner','admin','bursar','teacher','parent','student']::text[]`,
    ),
  ],
);

/** Append-only audit trail. The application role may insert and read, never update or delete. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: inet("ip_address"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_events_tenant_time_idx").on(t.tenantId, t.occurredAt)],
);

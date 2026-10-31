import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    /** Roles that must use two-step verification at this school (D-03 default: owner, bursar). */
    mfaRequiredRoles: text("mfa_required_roles")
      .array()
      .notNull()
      .default(sql`ARRAY['owner','bursar']::text[]`),
    ...timestamps,
  },
  (t) => [
    check(
      "tenants_mfa_required_roles_valid",
      sql`${t.mfaRequiredRoles} <@ ARRAY['owner','admin','bursar','teacher','parent','student']::text[]`,
    ),
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
  /** E.164. Unique once verified; used for SMS and phone sign-in. */
  phone: text("phone").unique(),
  phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
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

/**
 * Transactional outbox for email and SMS. Rows are written in the same transaction as the business change,
 * then delivered after commit and retried by the worker. Payloads are cleared once sent.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: text("channel", { enum: ["email", "sms"] }).notNull(),
    recipient: text("recipient").notNull(),
    template: text("template").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["pending", "sending", "sent", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("notification_outbox_due_idx").on(t.status, t.nextAttemptAt)],
);

/** Single-use password reset tokens (hash only), valid for 30 minutes. */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    requestedIp: inet("requested_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("password_resets_user_idx").on(t.userId, t.createdAt)],
);

/** SMS codes proving ownership of a phone number before it is attached to an account. */
export const phoneVerifications = pgTable(
  "phone_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("phone_verifications_user_idx").on(t.userId, t.createdAt)],
);

/** TOTP two-step verification. The seed is encrypted at rest (src/server/auth/secret-box.ts). */
export const userMfa = pgTable("user_mfa", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  secretSealed: text("secret_sealed").notNull(),
  /** Null while enrolment is pending confirmation. */
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  /** Last accepted time step; codes at or before it are rejected (replay protection). */
  lastUsedStep: bigint("last_used_step", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Single-use recovery codes, stored hashed. */
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mfa_recovery_codes_user_idx").on(t.userId)],
);

/** A password-verified sign-in waiting for the second step. Only the token hash is stored. */
export const mfaChallenges = pgTable(
  "mfa_challenges",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mfa_challenges_user_idx").on(t.userId)],
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
    unique("memberships_tenant_id_unique").on(t.tenantId, t.id),
    index("memberships_user_id_idx").on(t.userId),
    check("memberships_roles_not_empty", sql`cardinality(${t.roles}) > 0`),
    check(
      "memberships_roles_valid",
      sql`${t.roles} <@ ARRAY['owner','admin','bursar','teacher','parent','student']::text[]`,
    ),
  ],
);

/** EduBridge staff who can operate the platform (create and suspend schools, set plan limits). */
export const platformAdmins = pgTable("platform_admins", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Plan limits for a school, editable only by platform administrators. */
export const tenantEntitlements = pgTable(
  "tenant_entitlements",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "restrict" }),
    planName: text("plan_name").notNull().default("Pilot"),
    maxCampuses: integer("max_campuses").notNull().default(1),
    /** Null means no limit. Enforced once student records exist. */
    maxStudents: integer("max_students"),
    ...timestamps,
  },
  (t) => [
    check("tenant_entitlements_max_campuses_range", sql`${t.maxCampuses} between 1 and 1000`),
    check(
      "tenant_entitlements_max_students_range",
      sql`${t.maxStudents} is null or ${t.maxStudents} between 1 and 1000000`,
    ),
  ],
);

/** A school site. Campus is an authorization dimension within a tenant, not an isolation boundary. */
export const campuses = pgTable(
  "campuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: citext("name").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("campuses_tenant_name_unique").on(t.tenantId, t.name),
    unique("campuses_tenant_id_unique").on(t.tenantId, t.id),
    check("campuses_name_length", sql`char_length(${t.name}) between 2 and 80`),
  ],
);

/** Restricts a membership to specific campuses. No rows means access to every campus. */
export const membershipCampuses = pgTable(
  "membership_campuses",
  {
    tenantId: uuid("tenant_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    campusId: uuid("campus_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.campusId] }),
    foreignKey({
      name: "membership_campuses_membership_fk",
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "membership_campuses_campus_fk",
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }).onDelete("restrict"),
    index("membership_campuses_campus_idx").on(t.tenantId, t.campusId),
  ],
);

/** Single-use invitation to join a school. Only the SHA-256 hash of the token is stored. */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    email: citext("email").notNull(),
    roles: text("roles").array().notNull(),
    /** Campuses the new membership will be limited to; null means every campus. */
    campusIds: uuid("campus_ids").array(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedUserId: uuid("accepted_user_id").references(() => users.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("invitations_tenant_email_idx").on(t.tenantId, t.email),
    check("invitations_roles_not_empty", sql`cardinality(${t.roles}) > 0`),
    check(
      "invitations_roles_valid",
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

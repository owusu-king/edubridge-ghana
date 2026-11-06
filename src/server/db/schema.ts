import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
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
import type { AssessmentComponent, GradeBand, ReportCardSnapshot } from "../../lib/assessment";
import { MOBILE_MONEY_NETWORKS } from "../../lib/mobile-money";

/** Case-insensitive text (requires the `citext` extension, enabled in the first migration). */
const citext = customType<{ data: string }>({ dataType: () => "citext" });

/** Binary data (generated PDFs). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

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
      sql`${t.mfaRequiredRoles} <@ ARRAY['owner','headteacher','admin','bursar','teacher','parent','student']::text[]`,
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
      sql`${t.roles} <@ ARRAY['owner','headteacher','admin','bursar','teacher','parent','student']::text[]`,
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

/**
 * Academic years and their terms. Dates are school-local calendar dates (no time zone). The database
 * rejects overlapping years or terms within a school, and allows one current term per school.
 */
export const academicYears = pgTable(
  "academic_years",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique("academic_years_tenant_name_unique").on(t.tenantId, t.name),
    unique("academic_years_tenant_id_unique").on(t.tenantId, t.id),
    check("academic_years_dates", sql`${t.endsOn} > ${t.startsOn}`),
  ],
);

export const terms = pgTable(
  "terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    academicYearId: uuid("academic_year_id").notNull(),
    name: text("name").notNull(),
    sequence: integer("sequence").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "terms_academic_year_fk",
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }).onDelete("cascade"),
    unique("terms_year_sequence_unique").on(t.academicYearId, t.sequence),
    unique("terms_tenant_id_unique").on(t.tenantId, t.id),
    check("terms_dates", sql`${t.endsOn} > ${t.startsOn}`),
    check("terms_sequence_range", sql`${t.sequence} between 1 and 6`),
  ],
);

/** Grade levels in promotion order (e.g. KG 2 -> Basic 1). The stage selects defaults such as grading scales. */
export const levels = pgTable(
  "levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: citext("name").notNull(),
    stage: text("stage", { enum: ["creche", "nursery", "kindergarten", "primary", "jhs"] }).notNull(),
    sequence: integer("sequence").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("levels_tenant_name_unique").on(t.tenantId, t.name),
    unique("levels_tenant_id_unique").on(t.tenantId, t.id),
    check("levels_name_length", sql`char_length(${t.name}) between 1 and 40`),
  ],
);

/** A class (stream) within a level at a campus, e.g. "Basic 4A", with an optional class teacher. */
export const classes = pgTable(
  "classes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    levelId: uuid("level_id").notNull(),
    campusId: uuid("campus_id").notNull(),
    name: citext("name").notNull(),
    classTeacherMembershipId: uuid("class_teacher_membership_id"),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "classes_level_fk",
      columns: [t.tenantId, t.levelId],
      foreignColumns: [levels.tenantId, levels.id],
    }),
    foreignKey({
      name: "classes_campus_fk",
      columns: [t.tenantId, t.campusId],
      foreignColumns: [campuses.tenantId, campuses.id],
    }),
    foreignKey({
      name: "classes_class_teacher_fk",
      columns: [t.tenantId, t.classTeacherMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    unique("classes_campus_name_unique").on(t.tenantId, t.campusId, t.name),
    unique("classes_tenant_id_unique").on(t.tenantId, t.id),
    check("classes_name_length", sql`char_length(${t.name}) between 1 and 40`),
  ],
);

/** Per-school counters for human-readable numbers (admission numbers now; receipts later). */
export const tenantCounters = pgTable(
  "tenant_counters",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

/**
 * A learner. Data minimisation: only what schools need for class lists, fees and report cards.
 * Medical and other sensitive details are deliberately not stored yet.
 */
export const students = pgTable(
  "students",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    admissionNumber: citext("admission_number").notNull(),
    firstName: text("first_name").notNull(),
    otherNames: text("other_names"),
    lastName: text("last_name").notNull(),
    sex: text("sex", { enum: ["female", "male"] }).notNull(),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    admittedOn: date("admitted_on", { mode: "string" }),
    status: text("status", { enum: ["active", "withdrawn", "graduated"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("students_tenant_admission_unique").on(t.tenantId, t.admissionNumber),
    unique("students_tenant_id_unique").on(t.tenantId, t.id),
    index("students_tenant_name_idx").on(t.tenantId, t.lastName, t.firstName),
    check(
      "students_names_length",
      sql`char_length(${t.firstName}) between 1 and 60 and char_length(${t.lastName}) between 1 and 60`,
    ),
  ],
);

/** Which class a student is in for a term. One class per student per term. */
export const enrolments = pgTable(
  "enrolments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    studentId: uuid("student_id").notNull(),
    termId: uuid("term_id").notNull(),
    classId: uuid("class_id").notNull(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "enrolments_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enrolments_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    foreignKey({
      name: "enrolments_class_fk",
      columns: [t.tenantId, t.classId],
      foreignColumns: [classes.tenantId, classes.id],
    }),
    unique("enrolments_term_student_unique").on(t.termId, t.studentId),
    index("enrolments_class_term_idx").on(t.tenantId, t.classId, t.termId),
  ],
);

/**
 * A parent or guardian, per school. One record per phone number per school, so siblings share their
 * guardians. A portal account can be linked later (parent sign-in by SMS code).
 */
export const guardians = pgTable(
  "guardians",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    fullName: text("full_name").notNull(),
    phone: text("phone"),
    email: citext("email"),
    /**
     * Set when the school stops this guardian using the parent view (e.g. a custody change). Checked on
     * every parent request, so it takes effect immediately.
     */
    portalBlockedAt: timestamp("portal_blocked_at", { withTimezone: true }),
    portalBlockedByUserId: uuid("portal_blocked_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    ...timestamps,
  },
  (t) => [
    unique("guardians_tenant_id_unique").on(t.tenantId, t.id),
    check("guardians_contact", sql`${t.phone} is not null or ${t.email} is not null`),
    check("guardians_phone_e164", sql`${t.phone} is null or ${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
    check("guardians_name_length", sql`char_length(${t.fullName}) between 2 and 120`),
  ],
);

export const studentGuardians = pgTable(
  "student_guardians",
  {
    tenantId: uuid("tenant_id").notNull(),
    studentId: uuid("student_id").notNull(),
    guardianId: uuid("guardian_id").notNull(),
    relationship: text("relationship", {
      enum: ["mother", "father", "guardian", "grandparent", "sibling", "other"],
    }).notNull(),
    /** The contact for fees and messages about this student. One per student. */
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.studentId, t.guardianId] }),
    foreignKey({
      name: "student_guardians_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "student_guardians_guardian_fk",
      columns: [t.tenantId, t.guardianId],
      foreignColumns: [guardians.tenantId, guardians.id],
    }).onDelete("cascade"),
    index("student_guardians_guardian_idx").on(t.tenantId, t.guardianId),
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
      sql`${t.roles} <@ ARRAY['owner','headteacher','admin','bursar','teacher','parent','student']::text[]`,
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

/** Something a school charges for: tuition, PTA dues, books, feeding, and so on. */
export const feeItems = pgTable(
  "fee_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: citext("name").notNull(),
    /** Order on bills and statements. */
    sequence: integer("sequence").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("fee_items_tenant_name_unique").on(t.tenantId, t.name),
    unique("fee_items_tenant_id_unique").on(t.tenantId, t.id),
    check("fee_items_name_length", sql`char_length(${t.name}) between 1 and 60`),
  ],
);

/**
 * The amount charged for a fee item, per term, for a level. A row with a class overrides the level's
 * amount for that class (an amount of zero exempts the class). Amounts are integer pesewas.
 */
export const feeStructureLines = pgTable(
  "fee_structure_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    termId: uuid("term_id").notNull(),
    feeItemId: uuid("fee_item_id").notNull(),
    levelId: uuid("level_id").notNull(),
    classId: uuid("class_id"),
    amountPesewas: bigint("amount_pesewas", { mode: "number" }).notNull(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "fee_structure_lines_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    foreignKey({
      name: "fee_structure_lines_item_fk",
      columns: [t.tenantId, t.feeItemId],
      foreignColumns: [feeItems.tenantId, feeItems.id],
    }),
    foreignKey({
      name: "fee_structure_lines_level_fk",
      columns: [t.tenantId, t.levelId],
      foreignColumns: [levels.tenantId, levels.id],
    }),
    foreignKey({
      name: "fee_structure_lines_class_fk",
      columns: [t.tenantId, t.classId],
      foreignColumns: [classes.tenantId, classes.id],
    }),
    unique("fee_structure_lines_unique").on(t.termId, t.feeItemId, t.levelId, t.classId).nullsNotDistinct(),
    index("fee_structure_lines_term_idx").on(t.tenantId, t.termId),
    check("fee_structure_lines_amount_range", sql`${t.amountPesewas} between 0 and 1000000000`),
  ],
);

export const LEDGER_KINDS = [
  "charge",
  "payment",
  "discount",
  "adjustment",
  "opening_balance",
  "reversal",
] as const;

/**
 * A student's fee account, append-only. Positive amounts are owed by the family (charges); negative
 * amounts reduce what is owed (payments, discounts). The balance is the sum. Entries are never updated
 * or deleted: mistakes are corrected with a reversal that exactly negates the original (enforced by
 * triggers in migration 0025), so the full history is always preserved.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Global insertion order; statements sort by effective date, then this. */
    entryNumber: bigint("entry_number", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").notNull(),
    termId: uuid("term_id"),
    kind: text("kind", { enum: LEDGER_KINDS }).notNull(),
    feeItemId: uuid("fee_item_id"),
    description: text("description").notNull(),
    amountPesewas: bigint("amount_pesewas", { mode: "number" }).notNull(),
    /** Idempotency key for automatic entries, e.g. one charge per student, term and fee item. */
    billingKey: text("billing_key"),
    reversesEntryId: uuid("reverses_entry_id"),
    /** For payment entries (and their reversals): the payment and its receipt. */
    paymentId: uuid("payment_id"),
    /** The day the entry counts from, in the school's calendar. */
    effectiveOn: date("effective_on", { mode: "string" }).notNull(),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "ledger_entries_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: "ledger_entries_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    foreignKey({
      name: "ledger_entries_item_fk",
      columns: [t.tenantId, t.feeItemId],
      foreignColumns: [feeItems.tenantId, feeItems.id],
    }),
    foreignKey({
      name: "ledger_entries_reverses_fk",
      columns: [t.tenantId, t.reversesEntryId],
      foreignColumns: [t.tenantId, t.id],
    }),
    foreignKey({
      name: "ledger_entries_payment_fk",
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    unique("ledger_entries_tenant_id_unique").on(t.tenantId, t.id),
    unique("ledger_entries_billing_key_unique").on(t.tenantId, t.studentId, t.billingKey),
    unique("ledger_entries_reversed_once").on(t.reversesEntryId),
    index("ledger_entries_student_idx").on(t.tenantId, t.studentId, t.effectiveOn, t.entryNumber),
    index("ledger_entries_term_idx").on(t.tenantId, t.termId),
    check(
      "ledger_entries_amount_sign",
      sql`(${t.kind} = 'charge' and ${t.amountPesewas} > 0)
        or (${t.kind} in ('payment', 'discount') and ${t.amountPesewas} < 0)
        or (${t.kind} in ('adjustment', 'opening_balance', 'reversal') and ${t.amountPesewas} <> 0)`,
    ),
    check("ledger_entries_amount_range", sql`abs(${t.amountPesewas}) <= 1000000000`),
    check("ledger_entries_reversal_link", sql`(${t.kind} = 'reversal') = (${t.reversesEntryId} is not null)`),
    check("ledger_entries_description_length", sql`char_length(${t.description}) between 1 and 200`),
    check("ledger_entries_payment_link", sql`(${t.kind} = 'payment') <= (${t.paymentId} is not null)`),
  ],
);

export const PAYMENT_METHODS = ["cash", "mobile_money", "bank_deposit", "bank_transfer", "cheque"] as const;

/**
 * Money received from a family, recorded by staff. Insert-only like the ledger: a mistaken payment is
 * voided (payment_voids) and its ledger entry reversed, so the receipt number stays accounted for.
 * Receipt numbers are sequential per school with no gaps (allocated in the same transaction).
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").notNull(),
    receiptNumber: text("receipt_number").notNull(),
    amountPesewas: bigint("amount_pesewas", { mode: "number" }).notNull(),
    method: text("method", { enum: PAYMENT_METHODS }).notNull(),
    /** Bank slip, cheque or Mobile Money transaction number. */
    reference: text("reference"),
    payerName: text("payer_name"),
    paidOn: date("paid_on", { mode: "string" }).notNull(),
    /** Sent with the form so a double submission records one payment. */
    idempotencyKey: text("idempotency_key").notNull(),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "payments_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    unique("payments_tenant_id_unique").on(t.tenantId, t.id),
    unique("payments_tenant_receipt_unique").on(t.tenantId, t.receiptNumber),
    unique("payments_tenant_idempotency_unique").on(t.tenantId, t.idempotencyKey),
    index("payments_tenant_paid_on_idx").on(t.tenantId, t.paidOn),
    index("payments_student_idx").on(t.tenantId, t.studentId),
    check("payments_amount_range", sql`${t.amountPesewas} between 1 and 1000000000`),
    check(
      "payments_reference_length",
      sql`${t.reference} is null or char_length(${t.reference}) between 1 and 60`,
    ),
    check(
      "payments_payer_length",
      sql`${t.payerName} is null or char_length(${t.payerName}) between 1 and 120`,
    ),
  ],
);

/** A voided payment. One per payment; recorded with the reversal of its ledger entry. */
export const paymentVoids = pgTable(
  "payment_voids",
  {
    paymentId: uuid("payment_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    reason: text("reason").notNull(),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    voidedAt: timestamp("voided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "payment_voids_payment_fk",
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    check("payment_voids_reason_length", sql`char_length(${t.reason}) between 3 and 120`),
  ],
);

/**
 * A scholarship or discount for one student: a percentage (basis points) of one fee item or of every
 * item, or a fixed amount off one item, each term. Billing turns it into separate discount entries in
 * the ledger, so the concession can end without changing anything already billed.
 */
export const feeConcessions = pgTable(
  "fee_concessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").notNull(),
    label: text("label").notNull(),
    /** Null: applies to every fee item. */
    feeItemId: uuid("fee_item_id"),
    percentBasisPoints: integer("percent_basis_points"),
    amountPesewas: bigint("amount_pesewas", { mode: "number" }),
    status: text("status", { enum: ["active", "ended"] })
      .notNull()
      .default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "fee_concessions_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: "fee_concessions_item_fk",
      columns: [t.tenantId, t.feeItemId],
      foreignColumns: [feeItems.tenantId, feeItems.id],
    }),
    index("fee_concessions_student_idx").on(t.tenantId, t.studentId),
    check("fee_concessions_label_length", sql`char_length(${t.label}) between 2 and 60`),
    check("fee_concessions_one_kind", sql`(${t.percentBasisPoints} is null) <> (${t.amountPesewas} is null)`),
    check(
      "fee_concessions_percent_range",
      sql`${t.percentBasisPoints} is null or ${t.percentBasisPoints} between 1 and 10000`,
    ),
    check(
      "fee_concessions_amount_range",
      sql`${t.amountPesewas} is null or (${t.amountPesewas} between 1 and 1000000000 and ${t.feeItemId} is not null)`,
    ),
    check("fee_concessions_ended", sql`(${t.status} = 'ended') = (${t.endedAt} is not null)`),
  ],
);

/**
 * An instalment schedule agreed with a family for what they owe. It does not change the ledger: progress
 * is measured against payments recorded since the plan started. Plans can be cancelled, not edited.
 */
export const paymentPlans = pgTable(
  "payment_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").notNull(),
    totalPesewas: bigint("total_pesewas", { mode: "number" }).notNull(),
    /** The day the plan was agreed. Payments recorded after it count towards the plan. */
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    status: text("status", { enum: ["active", "cancelled"] })
      .notNull()
      .default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "payment_plans_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    unique("payment_plans_tenant_id_unique").on(t.tenantId, t.id),
    index("payment_plans_student_idx").on(t.tenantId, t.studentId),
    check("payment_plans_total_range", sql`${t.totalPesewas} between 1 and 1000000000`),
    check("payment_plans_cancelled", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
  ],
);

export const paymentPlanInstalments = pgTable(
  "payment_plan_instalments",
  {
    tenantId: uuid("tenant_id").notNull(),
    planId: uuid("plan_id").notNull(),
    sequence: integer("sequence").notNull(),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    amountPesewas: bigint("amount_pesewas", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.planId, t.sequence] }),
    foreignKey({
      name: "payment_plan_instalments_plan_fk",
      columns: [t.tenantId, t.planId],
      foreignColumns: [paymentPlans.tenantId, paymentPlans.id],
    }),
    check("payment_plan_instalments_sequence_range", sql`${t.sequence} between 1 and 12`),
    check("payment_plan_instalments_amount_range", sql`${t.amountPesewas} between 1 and 1000000000`),
  ],
);

export const MOBILE_MONEY_REQUEST_STATUSES = [
  "pending",
  "successful",
  "failed",
  "expired",
  "needs_review",
] as const;

/**
 * A prompt sent to a payer's phone to approve a Mobile Money payment. The payment itself is recorded in
 * `payments` (with its receipt and ledger entry) only once the provider confirms it for the requested
 * amount. Details never change after creation; only the outcome is filled in, once (a trigger enforces
 * this). "expired" means nobody answered in time locally; a late confirmation is still recorded.
 */
export const mobileMoneyRequests = pgTable(
  "mobile_money_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").notNull(),
    provider: text("provider").notNull(),
    network: text("network", { enum: MOBILE_MONEY_NETWORKS }).notNull(),
    msisdn: text("msisdn").notNull(),
    amountPesewas: bigint("amount_pesewas", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("GHS"),
    status: text("status", { enum: MOBILE_MONEY_REQUEST_STATUSES }).notNull().default("pending"),
    /** The provider's id for the request, once it has accepted it. */
    providerReference: text("provider_reference"),
    /** The network's transaction id for a confirmed payment. */
    transactionId: text("transaction_id"),
    /** Why the request failed or needs review; safe to show staff. */
    statusReason: text("status_reason"),
    paymentId: uuid("payment_id"),
    /** Sent with the form so a double submission sends one prompt. */
    idempotencyKey: text("idempotency_key").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** A payment held for review is closed by staff once they have checked it, with what they found. */
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    reviewNote: text("review_note"),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "mobile_money_requests_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: "mobile_money_requests_payment_fk",
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    unique("mobile_money_requests_tenant_id_unique").on(t.tenantId, t.id),
    unique("mobile_money_requests_tenant_idempotency_unique").on(t.tenantId, t.idempotencyKey),
    unique("mobile_money_requests_payment_unique").on(t.paymentId),
    index("mobile_money_requests_student_idx").on(t.tenantId, t.studentId, t.createdAt),
    check("mobile_money_requests_amount_range", sql`${t.amountPesewas} between 1 and 1000000000`),
    check("mobile_money_requests_currency", sql`${t.currency} = 'GHS'`),
    check("mobile_money_requests_msisdn", sql`${t.msisdn} ~ '^[+]233[25][0-9]{8}$'`),
    check("mobile_money_requests_paid", sql`(${t.status} = 'successful') = (${t.paymentId} is not null)`),
    check(
      "mobile_money_requests_reason",
      sql`(${t.status} in ('failed', 'needs_review')) = (${t.statusReason} is not null)`,
    ),
    check(
      "mobile_money_requests_completed",
      sql`(${t.status} in ('successful', 'failed', 'needs_review')) = (${t.completedAt} is not null)`,
    ),
    check(
      "mobile_money_requests_review",
      sql`(${t.reviewedAt} is null) = (${t.reviewNote} is null)
        and (${t.reviewedAt} is null or ${t.status} = 'needs_review')
        and (${t.reviewNote} is null or char_length(${t.reviewNote}) between 3 and 200)`,
    ),
    check(
      "mobile_money_requests_lengths",
      sql`char_length(${t.provider}) between 1 and 40
        and (${t.providerReference} is null or char_length(${t.providerReference}) between 1 and 120)
        and (${t.transactionId} is null or char_length(${t.transactionId}) between 1 and 60)
        and (${t.statusReason} is null or char_length(${t.statusReason}) between 1 and 200)`,
    ),
  ],
);

/**
 * Callbacks received from Mobile Money providers, stored before anything else happens so none is lost.
 * A callback only says which request to look at: its content is never trusted, and the outcome always
 * comes from asking the provider. The raw body is not kept (it may hold personal data); its SHA-256
 * makes provider retries count once.
 */
export const mobileMoneyCallbacks = pgTable(
  "mobile_money_callbacks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    /** Our request id, when the callback carries it. */
    requestId: uuid("request_id"),
    providerReference: text("provider_reference"),
    bodySha256: text("body_sha256").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /** The request's status after processing, or "unknown_request". */
    result: text("result"),
  },
  (t) => [
    unique("mobile_money_callbacks_dedupe").on(t.tenantId, t.provider, t.bodySha256),
    index("mobile_money_callbacks_unprocessed_idx").on(t.tenantId, t.receivedAt),
    check(
      "mobile_money_callbacks_lengths",
      sql`char_length(${t.provider}) between 1 and 40
        and (${t.providerReference} is null or char_length(${t.providerReference}) between 1 and 120)
        and char_length(${t.bodySha256}) = 64
        and (${t.result} is null or char_length(${t.result}) between 1 and 40)`,
    ),
    check(
      "mobile_money_callbacks_ref",
      sql`${t.requestId} is not null or ${t.providerReference} is not null`,
    ),
    check("mobile_money_callbacks_processed", sql`(${t.processedAt} is null) = (${t.result} is null)`),
  ],
);

/**
 * Fee reminders sent by SMS to a student's guardian. Insert-only, one per student per school day, so a
 * family is never sent the same reminder twice in a day. The message is queued in the notification
 * outbox in the same transaction, with the balance and a private balance link.
 */
export const feeReminders = pgTable(
  "fee_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").notNull(),
    guardianId: uuid("guardian_id").notNull(),
    channel: text("channel", { enum: ["sms"] }).notNull(),
    /** E.164 number the reminder was sent to (kept even if the guardian's number changes later). */
    recipient: text("recipient").notNull(),
    /** The school day it was sent, in the school's time zone. */
    sentOn: date("sent_on", { mode: "string" }).notNull(),
    /** What the student owed when the reminder was sent (also in the message). */
    balancePesewas: bigint("balance_pesewas", { mode: "number" }).notNull(),
    sentByUserId: uuid("sent_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "fee_reminders_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: "fee_reminders_guardian_fk",
      columns: [t.tenantId, t.guardianId],
      foreignColumns: [guardians.tenantId, guardians.id],
    }),
    unique("fee_reminders_once_a_day").on(t.tenantId, t.studentId, t.channel, t.sentOn),
    check("fee_reminders_recipient", sql`${t.recipient} ~ '^[+][1-9][0-9]{7,14}$'`),
    check("fee_reminders_balance", sql`${t.balancePesewas} between 1 and 1000000000`),
  ],
);

/**
 * Parent sign-in codes (SMS, 6 digits, hash only). Global: a phone number may belong to guardians at several
 * schools. `tenant_ids` are the schools whose guardians had the number when the code was asked for; empty
 * means the number is unknown and no SMS was sent. Used for the per-number, per-network and per-school limits.
 */
export const parentSignInCodes = pgTable(
  "parent_sign_in_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    tenantIds: uuid("tenant_ids").array().notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ipAddress: inet("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("parent_sign_in_codes_phone_idx").on(t.phone, t.createdAt),
    index("parent_sign_in_codes_created_idx").on(t.createdAt),
    check("parent_sign_in_codes_phone", sql`${t.phone} ~ '^[+][1-9][0-9]{7,14}$'`),
  ],
);

/**
 * Parent sessions (30 days, renewed while in use). The parent is identified by a verified phone number;
 * which children they see is worked out on each request from the guardians each school has on file.
 * Only the SHA-256 hash of the token is stored.
 */
export const parentSessions = pgTable(
  "parent_sessions",
  {
    id: text("id").primaryKey(),
    phone: text("phone").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ipAddress: inet("ip_address"),
  },
  (t) => [
    index("parent_sessions_phone_idx").on(t.phone),
    index("parent_sessions_expires_idx").on(t.expiresAt),
    check("parent_sessions_phone", sql`${t.phone} ~ '^[+][1-9][0-9]{7,14}$'`),
  ],
);

/**
 * Read-only links to one student's balance, sent in fee reminders and valid for 7 days. A link works only
 * while the guardian it was sent to still has that number, is still linked to the student, and is not
 * blocked from the parent view. Insert-only; only the token's hash is stored.
 */
export const balanceLinks = pgTable(
  "balance_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").notNull(),
    guardianId: uuid("guardian_id").notNull(),
    recipient: text("recipient").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "balance_links_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "balance_links_guardian_fk",
      columns: [t.tenantId, t.guardianId],
      foreignColumns: [guardians.tenantId, guardians.id],
    }).onDelete("cascade"),
    check("balance_links_recipient", sql`${t.recipient} ~ '^[+][1-9][0-9]{7,14}$'`),
  ],
);

/** A subject a school teaches, e.g. "English Language". Which levels take it is in `level_subjects`. */
export const subjects = pgTable(
  "subjects",
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
    unique("subjects_tenant_name_unique").on(t.tenantId, t.name),
    unique("subjects_tenant_id_unique").on(t.tenantId, t.id),
    check("subjects_name_length", sql`char_length(${t.name}) between 1 and 60`),
  ],
);

/** The subjects a level takes, in report-card order. */
export const levelSubjects = pgTable(
  "level_subjects",
  {
    tenantId: uuid("tenant_id").notNull(),
    levelId: uuid("level_id").notNull(),
    subjectId: uuid("subject_id").notNull(),
    sequence: integer("sequence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.levelId, t.subjectId] }),
    foreignKey({
      name: "level_subjects_level_fk",
      columns: [t.tenantId, t.levelId],
      foreignColumns: [levels.tenantId, levels.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "level_subjects_subject_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }).onDelete("cascade"),
    index("level_subjects_tenant_idx").on(t.tenantId, t.levelId),
  ],
);

/**
 * How a term's subjects are assessed: the parts (e.g. class score 50%, exam 50%) and whether report cards
 * show class positions. One per term, created from the previous term's or the defaults when first used.
 */
export const assessmentSchemes = pgTable(
  "assessment_schemes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    termId: uuid("term_id").notNull(),
    components: jsonb("components").$type<AssessmentComponent[]>().notNull(),
    showPositions: boolean("show_positions").notNull().default(false),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "assessment_schemes_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }).onDelete("cascade"),
    unique("assessment_schemes_term_unique").on(t.tenantId, t.termId),
    check("assessment_schemes_components", sql`jsonb_typeof(${t.components}) = 'array'`),
  ],
);

/** A school's grade bands for one stage (KG, Primary, JHS…). Without a row, the stage's defaults apply. */
export const gradingScales = pgTable(
  "grading_scales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    stage: text("stage", { enum: ["creche", "nursery", "kindergarten", "primary", "jhs"] }).notNull(),
    bands: jsonb("bands").$type<GradeBand[]>().notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    unique("grading_scales_stage_unique").on(t.tenantId, t.stage),
    check("grading_scales_bands", sql`jsonb_typeof(${t.bands}) = 'array'`),
  ],
);

/**
 * One mark: a student's score for one part of one subject in a term, in tenths (37.5 → 375). Cleared marks
 * are deleted. A trigger refuses any change once the student's report card for the term is published.
 */
export const assessmentScores = pgTable(
  "assessment_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    termId: uuid("term_id").notNull(),
    studentId: uuid("student_id").notNull(),
    subjectId: uuid("subject_id").notNull(),
    componentKey: text("component_key").notNull(),
    scoreTenths: integer("score_tenths").notNull(),
    enteredByUserId: uuid("entered_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "assessment_scores_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    foreignKey({
      name: "assessment_scores_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "assessment_scores_subject_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    unique("assessment_scores_unique").on(t.tenantId, t.termId, t.studentId, t.subjectId, t.componentKey),
    index("assessment_scores_subject_idx").on(t.tenantId, t.termId, t.subjectId),
    check("assessment_scores_range", sql`${t.scoreTenths} between 0 and 10000`),
    check("assessment_scores_key", sql`char_length(${t.componentKey}) between 1 and 20`),
  ],
);

/**
 * A student's report card for a term. Remarks are written while it is a draft; publishing (head teacher)
 * freezes everything it shows into `snapshot` and locks the student's scores. A published card can only be
 * withdrawn back to draft (audited), never edited (trigger).
 */
export const reportCards = pgTable(
  "report_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    termId: uuid("term_id").notNull(),
    studentId: uuid("student_id").notNull(),
    status: text("status", { enum: ["draft", "published"] })
      .notNull()
      .default("draft"),
    attitude: text("attitude"),
    conduct: text("conduct"),
    interest: text("interest"),
    classTeacherRemark: text("class_teacher_remark"),
    headTeacherRemark: text("head_teacher_remark"),
    /** Days present and days the school was open, entered by hand until attendance is recorded (phase H). */
    daysPresent: integer("days_present"),
    daysOpen: integer("days_open"),
    snapshot: jsonb("snapshot").$type<ReportCardSnapshot>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "report_cards_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    foreignKey({
      name: "report_cards_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete("cascade"),
    unique("report_cards_term_student_unique").on(t.tenantId, t.termId, t.studentId),
    unique("report_cards_tenant_id_unique").on(t.tenantId, t.id),
    check(
      "report_cards_published_complete",
      sql`(${t.status} = 'published') = (${t.snapshot} is not null and ${t.publishedAt} is not null)`,
    ),
    check(
      "report_cards_attendance",
      sql`(${t.daysOpen} is null or ${t.daysOpen} between 0 and 366) and (${t.daysPresent} is null or (${t.daysPresent} >= 0 and (${t.daysOpen} is null or ${t.daysPresent} <= ${t.daysOpen})))`,
    ),
    check(
      "report_cards_text_length",
      sql`coalesce(char_length(${t.attitude}), 0) <= 60 and coalesce(char_length(${t.conduct}), 0) <= 60 and coalesce(char_length(${t.interest}), 0) <= 60 and coalesce(char_length(${t.classTeacherRemark}), 0) <= 500 and coalesce(char_length(${t.headTeacherRemark}), 0) <= 500`,
    ),
  ],
);

/**
 * A request to print published report cards in bulk. The worker (or the web process after responding)
 * renders one PDF per class, so progress shows class by class and a large school never needs one huge file.
 * Removed with its files after 7 days.
 */
export const reportCardBatches = pgTable(
  "report_card_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    termId: uuid("term_id").notNull(),
    classIds: uuid("class_ids").array().notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    error: text("error"),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "report_card_batches_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }).onDelete("cascade"),
    unique("report_card_batches_tenant_id_unique").on(t.tenantId, t.id),
    index("report_card_batches_status_idx").on(t.tenantId, t.status),
    check("report_card_batches_classes", sql`cardinality(${t.classIds}) between 1 and 200`),
  ],
);

/** One class's printed report cards from a batch, with the SHA-256 of the file (`02` §11). */
export const reportCardFiles = pgTable(
  "report_card_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    classId: uuid("class_id").notNull(),
    className: text("class_name").notNull(),
    reportCount: integer("report_count").notNull(),
    pdf: bytea("pdf"),
    sha256: text("sha256"),
    byteSize: integer("byte_size").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "report_card_files_batch_fk",
      columns: [t.tenantId, t.batchId],
      foreignColumns: [reportCardBatches.tenantId, reportCardBatches.id],
    }).onDelete("cascade"),
    unique("report_card_files_batch_class_unique").on(t.batchId, t.classId),
    check("report_card_files_pdf", sql`(${t.reportCount} = 0) = (${t.pdf} is null)`),
  ],
);

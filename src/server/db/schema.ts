import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
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
import { ATTENDANCE_STATUSES } from "../../lib/attendance";
import { MOBILE_MONEY_NETWORKS } from "../../lib/mobile-money";
import { BILLING_PERIODS, SUBSCRIPTION_STATUSES, type InvoiceLine } from "../../lib/plan";

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
    /**
     * A demonstration school filled with made-up data (`npm run demo:school`). Labelled as such everywhere,
     * never sends SMS or email, and is left out of parent sign-in. Set only by the demo script.
     */
    isDemo: boolean("is_demo").notNull().default(false),
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
    /** Active students allowed; null means no limit. Checked when students are added or reactivated. */
    maxStudents: integer("max_students"),
    /** Modules the plan includes (src/lib/plan.ts); checked on the server for every request. */
    features: text("features")
      .array()
      .notNull()
      .default(sql`ARRAY['attendance','assessment','parent_view','fee_reminders','mobile_money']::text[]`),
    /** SMS the school may send in a calendar month (reminders); null means no limit. */
    maxSmsPerMonth: integer("max_sms_per_month"),
    // The subscription (PLT-03). Billing is manual in R1: EduBridge records invoices and payments here.
    subscriptionStatus: text("subscription_status", { enum: SUBSCRIPTION_STATUSES })
      .notNull()
      .default("trial"),
    billingPeriod: text("billing_period", { enum: BILLING_PERIODS }).notNull().default("termly"),
    trialEndsOn: date("trial_ends_on", { mode: "string" }),
    /** The end of the period the school has paid for. */
    paidUntil: date("paid_until", { mode: "string" }),
    /** The agreed price per billing period, in the school's currency. */
    pricePesewas: bigint("price_pesewas", { mode: "number" }),
    /** Price per SMS for this school; null uses the platform's price (platform_settings). */
    smsPricePesewas: bigint("sms_price_pesewas", { mode: "number" }),
    /**
     * The school's own account with the payment provider (a Paystack subaccount code, ACCT_...), so its
     * money settles to the school directly (D-07). Set by platform staff.
     */
    settlementAccount: text("settlement_account"),
    billingNotes: text("billing_notes"),
    ...timestamps,
  },
  (t) => [
    check("tenant_entitlements_max_campuses_range", sql`${t.maxCampuses} between 1 and 1000`),
    check(
      "tenant_entitlements_max_students_range",
      sql`${t.maxStudents} is null or ${t.maxStudents} between 1 and 1000000`,
    ),
    check(
      "tenant_entitlements_features_valid",
      sql`${t.features} <@ ARRAY['attendance','assessment','parent_view','fee_reminders','mobile_money','assistant']::text[]`,
    ),
    check(
      "tenant_entitlements_max_sms_range",
      sql`${t.maxSmsPerMonth} is null or ${t.maxSmsPerMonth} between 0 and 1000000`,
    ),
    check(
      "tenant_entitlements_price_range",
      sql`${t.pricePesewas} is null or ${t.pricePesewas} between 0 and 1000000000`,
    ),
    check(
      "tenant_entitlements_sms_price_range",
      sql`${t.smsPricePesewas} is null or ${t.smsPricePesewas} between 0 and 100000`,
    ),
    check(
      "tenant_entitlements_settlement_account_format",
      sql`${t.settlementAccount} is null or ${t.settlementAccount} ~ '^[A-Za-z0-9_]{4,40}$'`,
    ),
    check(
      "tenant_entitlements_notes_length",
      sql`${t.billingNotes} is null or char_length(${t.billingNotes}) <= 500`,
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
    /**
     * The child's portable learner identity (Transfer Passport): the same across schools once records move
     * with consent. Set by the database when a student is created without one.
     */
    learnerId: uuid("learner_id").references(() => learners.id, { onDelete: "restrict" }),
    /** Why the student left (e.g. transferred to another school), when withdrawn. */
    leftReason: text("left_reason"),
    ...timestamps,
  },
  (t) => [
    unique("students_tenant_admission_unique").on(t.tenantId, t.admissionNumber),
    unique("students_tenant_learner_unique").on(t.tenantId, t.learnerId),
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
    /**
     * Set when EduBridge support made the change during a support grant (PLT-02). Filled from the
     * transaction's `app.support_grant_id`, which `withTenant` sets for support contexts, so no caller can
     * forget it.
     */
    supportGrantId: uuid("support_grant_id").default(
      sql`nullif(current_setting('app.support_grant_id', true), '')::uuid`,
    ),
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
    /** Added by a person, or by the school's sibling discount rule (which also ends its own). */
    source: text("source", { enum: ["manual", "sibling_rule"] })
      .notNull()
      .default("manual"),
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

/** A class register for one school day: that it was taken, by whom, in which term. One per class and date. */
export const attendanceRegisters = pgTable(
  "attendance_registers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    classId: uuid("class_id").notNull(),
    termId: uuid("term_id").notNull(),
    /** The school day (school-local calendar date). */
    date: date("date", { mode: "string" }).notNull(),
    takenByUserId: uuid("taken_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "attendance_registers_class_fk",
      columns: [t.tenantId, t.classId],
      foreignColumns: [classes.tenantId, classes.id],
    }),
    foreignKey({
      name: "attendance_registers_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    unique("attendance_registers_class_date_unique").on(t.tenantId, t.classId, t.date),
    unique("attendance_registers_tenant_id_unique").on(t.tenantId, t.id),
    index("attendance_registers_term_idx").on(t.tenantId, t.termId),
  ],
);

/**
 * One student's mark on a register. `version` goes up by one on every change: a change made offline names
 * the version it was based on, and is applied only if that is still the current one (never last-write-wins).
 */
export const attendanceMarks = pgTable(
  "attendance_marks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    registerId: uuid("register_id").notNull(),
    studentId: uuid("student_id").notNull(),
    status: text("status", { enum: ATTENDANCE_STATUSES }).notNull(),
    reason: text("reason"),
    version: integer("version").notNull().default(1),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "attendance_marks_register_fk",
      columns: [t.tenantId, t.registerId],
      foreignColumns: [attendanceRegisters.tenantId, attendanceRegisters.id],
    }),
    foreignKey({
      name: "attendance_marks_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete("cascade"),
    unique("attendance_marks_register_student_unique").on(t.registerId, t.studentId),
    unique("attendance_marks_tenant_id_unique").on(t.tenantId, t.id),
    index("attendance_marks_student_idx").on(t.tenantId, t.studentId),
    check("attendance_marks_reason_length", sql`coalesce(char_length(${t.reason}), 0) <= 120`),
    check("attendance_marks_version", sql`${t.version} >= 1`),
  ],
);

/**
 * Every change to a mark, insert-only: before and after, who, how it arrived (online, synced from a device
 * that was offline, or a conflict the teacher resolved by keeping their own mark) and when it was recorded on
 * the device. Nothing about attendance is ever overwritten without a trace.
 */
export const attendanceChanges = pgTable(
  "attendance_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    markId: uuid("mark_id").notNull(),
    studentId: uuid("student_id").notNull(),
    fromStatus: text("from_status", { enum: ATTENDANCE_STATUSES }),
    toStatus: text("to_status", { enum: ATTENDANCE_STATUSES }).notNull(),
    fromReason: text("from_reason"),
    toReason: text("to_reason"),
    version: integer("version").notNull(),
    source: text("source", { enum: ["online", "offline", "kept_mine"] }).notNull(),
    recordedOnDeviceAt: timestamp("recorded_on_device_at", { withTimezone: true }),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "attendance_changes_mark_fk",
      columns: [t.tenantId, t.markId],
      foreignColumns: [attendanceMarks.tenantId, attendanceMarks.id],
    }).onDelete("cascade"),
    index("attendance_changes_mark_idx").on(t.tenantId, t.markId),
  ],
);

/**
 * SMS a school is charged for, one row per message (and per school, for a parent sign-in code sent to a
 * number several schools have: `shared_with` says how many). Insert-only, written when the message is
 * queued; whether it was delivered comes from the outbox. Kept after codes and sessions are purged.
 */
export const smsUsage = pgTable(
  "sms_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    kind: text("kind", {
      enum: ["fee_reminder", "parent_code", "absence_alert", "payment_receipt", "announcement"],
    }).notNull(),
    /** The student the message was about (for each student's message history); null for codes and announcements. */
    studentId: uuid("student_id"),
    outboxId: uuid("outbox_id")
      .notNull()
      .references(() => notificationOutbox.id, { onDelete: "restrict" }),
    sharedWith: integer("shared_with").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("sms_usage_outbox_tenant_unique").on(t.outboxId, t.tenantId),
    index("sms_usage_tenant_created_idx").on(t.tenantId, t.createdAt),
    check("sms_usage_shared_with_range", sql`${t.sharedWith} between 1 and 100`),
  ],
);

/**
 * EduBridge's invoices to a school for its subscription and usage (manual billing in R1). Issued
 * invoices never change: they can only be marked paid, or voided with a reason, each once (trigger).
 */
export const subscriptionInvoices = pgTable(
  "subscription_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** EB-2026-000123, from a platform-wide sequence. */
    invoiceNumber: text("invoice_number").notNull().unique(),
    lines: jsonb("lines").$type<InvoiceLine[]>().notNull(),
    totalPesewas: bigint("total_pesewas", { mode: "number" }).notNull(),
    currencyCode: text("currency_code").notNull(),
    periodStartsOn: date("period_starts_on", { mode: "string" }).notNull(),
    periodEndsOn: date("period_ends_on", { mode: "string" }).notNull(),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    paidOn: date("paid_on", { mode: "string" }),
    paymentReference: text("payment_reference"),
    paymentRecordedByUserId: uuid("payment_recorded_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("subscription_invoices_tenant_idx").on(t.tenantId, t.issuedOn),
    check("subscription_invoices_total_range", sql`${t.totalPesewas} between 1 and 1000000000`),
    check("subscription_invoices_period", sql`${t.periodEndsOn} >= ${t.periodStartsOn}`),
    check("subscription_invoices_due", sql`${t.dueOn} >= ${t.issuedOn}`),
    check("subscription_invoices_paid_or_void", sql`${t.paidOn} is null or ${t.voidedAt} is null`),
    check("subscription_invoices_void_reason", sql`(${t.voidedAt} is null) = (${t.voidReason} is null)`),
    check("subscription_invoices_currency_format", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * Students moved from one term's classes into another's in one step: the same classes within a year, or up a
 * level at the start of a new year (with the last level graduating). Kept so a move can be undone while
 * nothing has been recorded against it yet.
 */
export const termMoves = pgTable(
  "term_moves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    fromTermId: uuid("from_term_id").notNull(),
    toTermId: uuid("to_term_id").notNull(),
    newYear: boolean("new_year").notNull(),
    placed: integer("placed").notNull(),
    /** Students this move marked as graduated (set back to active if the move is undone). */
    graduatedStudentIds: uuid("graduated_student_ids").array().notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneByUserId: uuid("undone_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    foreignKey({
      name: "term_moves_from_term_fk",
      columns: [t.tenantId, t.fromTermId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    foreignKey({
      name: "term_moves_to_term_fk",
      columns: [t.tenantId, t.toTermId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    unique("term_moves_tenant_id_unique").on(t.tenantId, t.id),
    index("term_moves_tenant_idx").on(t.tenantId, t.createdAt),
    check("term_moves_terms_differ", sql`${t.fromTermId} <> ${t.toTermId}`),
    check("term_moves_placed_range", sql`${t.placed} >= 0`),
  ],
);

/** The class placements a move created (removed with them if the move is undone). */
export const termMoveEnrolments = pgTable(
  "term_move_enrolments",
  {
    tenantId: uuid("tenant_id").notNull(),
    moveId: uuid("move_id").notNull(),
    enrolmentId: uuid("enrolment_id")
      .notNull()
      .references(() => enrolments.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.moveId, t.enrolmentId] }),
    foreignKey({
      name: "term_move_enrolments_move_fk",
      columns: [t.tenantId, t.moveId],
      foreignColumns: [termMoves.tenantId, termMoves.id],
    }).onDelete("cascade"),
  ],
);

/**
 * Settings for the whole platform (one row): the default price of an SMS charged to schools, and how many
 * days a school has after an invoice falls due before school-initiated SMS pause. Platform staff only.
 */
export const platformSettings = pgTable(
  "platform_settings",
  {
    id: boolean("id").primaryKey().default(true),
    smsPricePesewas: bigint("sms_price_pesewas", { mode: "number" }),
    graceDays: integer("grace_days").notNull().default(3),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    check("platform_settings_single_row", sql`${t.id}`),
    check("platform_settings_grace_range", sql`${t.graceDays} between 0 and 60`),
    check(
      "platform_settings_sms_price_range",
      sql`${t.smsPricePesewas} is null or ${t.smsPricePesewas} between 0 and 100000`,
    ),
  ],
);

/** Days the school is closed within a term (public holidays, mid-term breaks): no registers are taken. */
export const schoolHolidays = pgTable(
  "school_holidays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("school_holidays_tenant_idx").on(t.tenantId, t.startsOn),
    check("school_holidays_dates", sql`${t.endsOn} >= ${t.startsOn}`),
    check("school_holidays_span", sql`${t.endsOn} - ${t.startsOn} <= 60`),
    check("school_holidays_name_length", sql`char_length(${t.name}) between 2 and 80`),
  ],
);

/**
 * When families get an SMS about absences: after a number of school days absent in a row, and/or a total in
 * a term. Off until a school turns it on (each SMS costs the school).
 */
export const absenceAlertSettings = pgTable(
  "absence_alert_settings",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(false),
    consecutiveDays: integer("consecutive_days"),
    termDays: integer("term_days"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    check(
      "absence_alert_settings_consecutive",
      sql`${t.consecutiveDays} is null or ${t.consecutiveDays} between 1 and 30`,
    ),
    check("absence_alert_settings_term", sql`${t.termDays} is null or ${t.termDays} between 1 and 100`),
    check(
      "absence_alert_settings_some_rule",
      sql`not ${t.enabled} or ${t.consecutiveDays} is not null or ${t.termDays} is not null`,
    ),
  ],
);

/**
 * Absence SMS sent to families. Insert-only; one per student per run of absences (keyed by the run's first
 * day) and one per term for the term total, so a family never gets the same alert twice.
 */
export const absenceAlerts = pgTable(
  "absence_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    studentId: uuid("student_id").notNull(),
    termId: uuid("term_id").notNull(),
    kind: text("kind", { enum: ["consecutive", "term_total"] }).notNull(),
    /** The run's first day (consecutive) or the threshold reached (term total), as text. */
    key: text("key").notNull(),
    days: integer("days").notNull(),
    guardianId: uuid("guardian_id"),
    recipient: text("recipient").notNull(),
    /** Null when nothing was sent (demo school). */
    outboxId: uuid("outbox_id").references(() => notificationOutbox.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "absence_alerts_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: "absence_alerts_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    unique("absence_alerts_once").on(t.tenantId, t.studentId, t.termId, t.kind, t.key),
    index("absence_alerts_student_idx").on(t.tenantId, t.studentId),
  ],
);

/**
 * A school's own choices about how EduBridge works for it: whether Accountants may void receipts (the
 * Proprietor decides), and how two overview figures are defined. Defaults apply when there is no row.
 */
export const schoolPreferences = pgTable(
  "school_preferences",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "restrict" }),
    accountantsCanVoid: boolean("accountants_can_void").notNull().default(false),
    /** "due": collected ÷ (owed at the start + billed); "billed": collected ÷ billed for the term. */
    collectionRateBasis: text("collection_rate_basis", { enum: ["due", "billed"] })
      .notNull()
      .default("due"),
    attendanceConcernPercent: integer("attendance_concern_percent").notNull().default(80),
    attendanceConcernMinDays: integer("attendance_concern_min_days").notNull().default(5),
    /** SMS the payer's family when a payment is recorded (each SMS is charged to the school). */
    paymentReceiptSms: boolean("payment_receipt_sms").notNull().default(false),
    /** Automatic fee reminders: every so many days to families owing at least the minimum. */
    autoRemindersEnabled: boolean("auto_reminders_enabled").notNull().default(false),
    autoReminderIntervalDays: integer("auto_reminder_interval_days").notNull().default(14),
    autoReminderMinPesewas: bigint("auto_reminder_min_pesewas", { mode: "number" }).notNull().default(10_000),
    /** The school day automatic reminders last ran (once a day, after 9:00 school time). */
    autoRemindersLastRunOn: date("auto_reminders_last_run_on", { mode: "string" }),
    /** How families reach the school (shown in the parent view). */
    contactPhone: text("contact_phone"),
    contactEmail: text("contact_email"),
    contactWhatsapp: text("contact_whatsapp"),
    officeHours: text("office_hours"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    check("school_preferences_concern_percent", sql`${t.attendanceConcernPercent} between 1 and 100`),
    check("school_preferences_concern_days", sql`${t.attendanceConcernMinDays} between 1 and 100`),
    check("school_preferences_reminder_interval", sql`${t.autoReminderIntervalDays} between 7 and 90`),
    check("school_preferences_reminder_min", sql`${t.autoReminderMinPesewas} between 0 and 1000000000`),
    check(
      "school_preferences_office_hours",
      sql`${t.officeHours} is null or char_length(${t.officeHours}) <= 120`,
    ),
  ],
);

/**
 * The school's sibling discount: which child counts as the first (paying in full), and the discount for the
 * second child and for each later one, on one fee item or all. Applied as discounts on each child.
 */
export const siblingDiscountRules = pgTable(
  "sibling_discount_rules",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "restrict" }),
    firstChild: text("first_child", { enum: ["eldest", "youngest", "highest_class", "lowest_class"] })
      .notNull()
      .default("eldest"),
    secondPercentBasisPoints: integer("second_percent_basis_points"),
    laterPercentBasisPoints: integer("later_percent_basis_points"),
    /** Null: every fee item. */
    feeItemId: uuid("fee_item_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    foreignKey({
      name: "sibling_discount_rules_item_fk",
      columns: [t.tenantId, t.feeItemId],
      foreignColumns: [feeItems.tenantId, feeItems.id],
    }),
    check(
      "sibling_discount_rules_second",
      sql`${t.secondPercentBasisPoints} is null or ${t.secondPercentBasisPoints} between 1 and 10000`,
    ),
    check(
      "sibling_discount_rules_later",
      sql`${t.laterPercentBasisPoints} is null or ${t.laterPercentBasisPoints} between 1 and 10000`,
    ),
  ],
);

/**
 * School announcements to families: the whole school, or one level, class or campus. Shown in the parent
 * view, and sent by SMS when chosen. Never edited once posted (a correction is a new announcement).
 */
export const announcements = pgTable(
  "announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    audience: text("audience", { enum: ["school", "level", "class", "campus"] }).notNull(),
    /** The level, class or campus; null for the whole school. */
    audienceId: uuid("audience_id"),
    smsCount: integer("sms_count").notNull().default(0),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("announcements_tenant_id_unique").on(t.tenantId, t.id),
    index("announcements_tenant_idx").on(t.tenantId, t.createdAt),
    check("announcements_title_length", sql`char_length(${t.title}) between 2 and 100`),
    check("announcements_body_length", sql`char_length(${t.body}) between 1 and 2000`),
    check("announcements_audience_id", sql`(${t.audience} = 'school') = (${t.audienceId} is null)`),
  ],
);

/** Which parent numbers have read an announcement (PRT-05). */
export const announcementReads = pgTable(
  "announcement_reads",
  {
    tenantId: uuid("tenant_id").notNull(),
    announcementId: uuid("announcement_id").notNull(),
    /** E.164: parents are their verified phone numbers. */
    phone: text("phone").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.announcementId, t.phone] }),
    foreignKey({
      name: "announcement_reads_announcement_fk",
      columns: [t.tenantId, t.announcementId],
      foreignColumns: [announcements.tenantId, announcements.id],
    }),
  ],
);

/**
 * Support access (PLT-02, D-08): the Proprietor lets EduBridge support into the school for a chosen time
 * (at most 7 days), and can end it early. While a grant is live, platform staff can open the school with
 * the Proprietor's permissions, except managing support access and exporting data. Never deleted; ending
 * is the only change, once.
 */
export const supportGrants = pgTable(
  "support_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** What the school needs help with, for support to read. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    unique("support_grants_tenant_id_unique").on(t.tenantId, t.id),
    index("support_grants_tenant_time_idx").on(t.tenantId, t.createdAt),
    check("support_grants_note_length", sql`char_length(${t.note}) <= 300`),
    check(
      "support_grants_duration",
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '7 days'`,
    ),
  ],
);

/** Every page support opened and every form it sent during a grant, shown to the Proprietor. */
export const supportViews = pgTable(
  "support_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    grantId: uuid("grant_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    path: text("path").notNull(),
    /** view: a page was opened; action: a form was sent (the change itself is in the audit log). */
    kind: text("kind", { enum: ["view", "action"] }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("support_views_grant_time_idx").on(t.tenantId, t.grantId, t.at),
    foreignKey({
      name: "support_views_grant_fk",
      columns: [t.tenantId, t.grantId],
      foreignColumns: [supportGrants.tenantId, supportGrants.id],
    }),
  ],
);

/**
 * Device tokens for the API (`/api/v1`): mobile apps, other clients and devices that sync offline. Issued
 * after the same sign-in as the web (password, then the second step when the user has one); only the
 * SHA-256 of the token is stored. Each is named, listed under Account, Devices, and revocable one by one;
 * changing or resetting the password revokes them all.
 */
export const deviceTokens = pgTable(
  "device_tokens",
  {
    /** SHA-256 of the token (hex), like session ids. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    ipAddress: inet("ip_address"),
  },
  (t) => [
    index("device_tokens_user_idx").on(t.userId),
    check("device_tokens_name_length", sql`char_length(${t.name}) between 1 and 80`),
  ],
);

/**
 * Operations sent by devices through the sync protocol (`src/server/sync`), recorded once per client
 * operation id in the same transaction as their effects, so a retried batch never applies anything twice:
 * a replay returns the stored outcome. Insert-only.
 */
export const syncOperations = pgTable(
  "sync_operations",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** Chosen by the device (a UUID), unique per school. */
    id: uuid("id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    status: text("status", { enum: ["applied", "conflict", "rejected"] }).notNull(),
    outcome: jsonb("outcome").$type<Record<string, unknown>>(),
    /** When the device says the change was made (offline changes are sent later). */
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index("sync_operations_user_idx").on(t.tenantId, t.userId),
  ],
);

/**
 * The change feed for devices: one row per change to records devices keep (students, class placements,
 * classes, register marks, marks), written by triggers so no code path can forget it. Devices ask for
 * changes after the last sequence number they saw; entries are kept 90 days.
 */
export const syncChanges = pgTable(
  "sync_changes",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    entity: text("entity", { enum: ["student", "class", "register", "score"] }).notNull(),
    entityId: uuid("entity_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sync_changes_tenant_seq_idx").on(t.tenantId, t.seq)],
);

/**
 * Portable learner identity (Transfer Passport). Deliberately holds no personal details: names, dates and
 * records stay in each school's rows, which point here. The id travels in signed learner records, so the
 * receiving school links its new student to the same learner.
 */
export const learners = pgTable("learners", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Signed learner records issued by a school (Transfer Passport): the record exactly as signed, its
 * SHA-256 and the Ed25519 signature. Never edited; a record can be revoked (once) if issued in error, which
 * verification then reports.
 */
export const learnerRecords = pgTable(
  "learner_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => learners.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").notNull(),
    purpose: text("purpose", { enum: ["transfer", "export"] }).notNull(),
    /** The signed record (its canonical JSON is what was signed). */
    record: jsonb("record").$type<Record<string, unknown>>().notNull(),
    sha256: text("sha256").notNull(),
    keyId: text("key_id").notNull(),
    signature: text("signature").notNull(),
    issuedByUserId: uuid("issued_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    unique("learner_records_tenant_id_unique").on(t.tenantId, t.id),
    index("learner_records_student_idx").on(t.tenantId, t.studentId),
    foreignKey({
      name: "learner_records_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);

export const TRANSFER_STATUSES = [
  "awaiting_consent",
  "awaiting_origin",
  "approved",
  "completed",
  "declined",
  "cancelled",
] as const;

/**
 * A move between two independent schools (Transfer Passport). Visible to both schools (row-level security
 * on either school id); what each sees is narrowed further by the service (the school a child is leaving
 * sees nothing until the family has consented). The family consents in the parent view, the school being
 * left approves (issuing a signed record, copied here) or declines, and the receiving school accepts,
 * which creates its student linked to the same learner.
 */
export const transfers = pgTable(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromTenantId: uuid("from_tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    toTenantId: uuid("to_tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** guardian: started by the family in the parent view; school: requested by the receiving school. */
    requestedBy: text("requested_by", { enum: ["guardian", "school"] }).notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    /** The child as the requester described them (the receiving school is not told whether they match). */
    childFirstName: text("child_first_name").notNull(),
    childLastName: text("child_last_name").notNull(),
    childDateOfBirth: date("child_date_of_birth", { mode: "string" }),
    /** E.164: the guardian whose consent is needed (a number the school being left has on file). */
    guardianPhone: text("guardian_phone").notNull(),
    /** The student at the school being left, once matched. */
    fromStudentId: uuid("from_student_id"),
    status: text("status", { enum: TRANSFER_STATUSES }).notNull(),
    consentPhone: text("consent_phone"),
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    declineReason: text("decline_reason"),
    recordId: uuid("record_id").references(() => learnerRecords.id, { onDelete: "restrict" }),
    /** The signed package, copied here on approval so the receiving school can read and verify it. */
    package: jsonb("package").$type<Record<string, unknown>>(),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    toStudentId: uuid("to_student_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("transfers_from_idx").on(t.fromTenantId, t.status),
    index("transfers_to_idx").on(t.toTenantId, t.status),
    check("transfers_two_schools", sql`${t.fromTenantId} <> ${t.toTenantId}`),
  ],
);

/**
 * Records a school received about one of its students from a previous school: through a transfer on
 * EduBridge (verified), or imported from a file (verified when it carries a valid EduBridge signature,
 * otherwise kept as unverified). Insert-only; the original is kept exactly as received.
 */
export const priorRecords = pgTable(
  "prior_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").notNull(),
    source: text("source", { enum: ["transfer", "import"] }).notNull(),
    verified: boolean("verified").notNull(),
    issuerName: text("issuer_name").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    /** The issuing school's record id, when it came from EduBridge. */
    sourceRecordId: uuid("source_record_id"),
    sha256: text("sha256").notNull(),
    package: jsonb("package").$type<Record<string, unknown>>().notNull(),
    importedByUserId: uuid("imported_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("prior_records_student_idx").on(t.tenantId, t.studentId),
    foreignKey({
      name: "prior_records_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);

/**
 * Every question asked of the school assistant (AI), with the records it read (tool calls and their
 * inputs), its answer, the model and token use. Insert-only, visible to those who see the audit log.
 * Questions asked by EduBridge support during a support grant carry the grant, as audit events do.
 */
export const assistantQueries = pgTable(
  "assistant_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    question: text("question").notNull(),
    answer: text("answer"),
    status: text("status", { enum: ["answered", "refused", "failed"] }).notNull(),
    /** Each record the assistant read: tool name, input, and whether the person's role allowed it. */
    tools: jsonb("tools").$type<{ name: string; input: unknown; allowed: boolean }[]>().notNull().default([]),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    supportGrantId: uuid("support_grant_id").default(
      sql`nullif(current_setting('app.support_grant_id', true), '')::uuid`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("assistant_queries_tenant_time_idx").on(t.tenantId, t.createdAt),
    check("assistant_queries_question_length", sql`char_length(${t.question}) between 1 and 500`),
  ],
);

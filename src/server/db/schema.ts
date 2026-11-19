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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { APPLICATION_SOURCES, APPLICATION_STATUSES, type AdmissionFee } from "../../lib/admissions";
import type { AssessmentComponent, GradeBand, ReportCardSnapshot } from "../../lib/assessment";
import { ATTENDANCE_STATUSES } from "../../lib/attendance";
import { CONSENT_ANSWERS, EVENT_REMINDERS } from "../../lib/events";
import { REPORT_CARD_STYLES } from "../../lib/report-styles";
import { STUDENT_STATUSES } from "../../lib/students";
import { EARLY_WARNING_RULES, REVIEW_OUTCOMES } from "../../lib/early-warning";
import { FINANCE_CHECK_RULES } from "../../lib/finance-checks";
import { MOBILE_MONEY_NETWORKS } from "../../lib/mobile-money";
import { ENTITLEMENT_SOURCES, PLAN_MODULE_IDS } from "../../lib/modules";
import { CASE_STATUSES, CONCERN_CATEGORIES, ENTRY_KINDS } from "../../lib/safeguarding";
import { PICKUP_OUTCOMES, VISIT_PURPOSES } from "../../lib/visitors";
import { RIDE_DIRECTIONS, TRIP_DIRECTIONS } from "../../lib/transport";
import { RESERVATION_STATUSES } from "../../lib/library";
import { HOUSE_KINDS } from "../../lib/boarding";
import type { PriceBand } from "../../lib/pricing";
import {
  ASSET_CONDITIONS,
  ASSET_EVENT_KINDS,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUSES,
  MOVEMENT_KINDS,
  PURCHASE_STATUSES,
} from "../../lib/inventory";
import { COMPONENT_BASES, COMPONENT_KINDS, PAYROLL_STATUSES, type PayItem } from "../../lib/payroll";
import {
  EMPLOYMENT_EVENT_KINDS,
  EMPLOYMENT_TYPES,
  LEAVE_STATUSES,
  STAFF_ATTENDANCE_MARKS,
} from "../../lib/staff";
import {
  BILLING_PERIODS,
  PLAN_REQUEST_STATUSES,
  SUBSCRIPTION_STATUSES,
  type InvoiceLine,
} from "../../lib/plan";

/** Case-insensitive text (requires the `citext` extension, enabled in the first migration). */
const citext = customType<{ data: string }>({ dataType: () => "citext" });

/** The module ids a plan or add-on may name (module registry); widened by a migration when modules are added. */
const PLAN_MODULES_SQL = sql.raw(`ARRAY[${PLAN_MODULE_IDS.map((id) => `'${id}'`).join(",")}]::text[]`);

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
    /** For push, the recipient is a `push_subscriptions` id. */
    channel: text("channel", { enum: ["email", "sms", "push"] }).notNull(),
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
    /** SMS segments the text takes (1 for email), worked out when queued; what the school is charged. */
    segments: integer("segments").notNull().default(1),
    /** Set by senders that may run twice for the same event: the same key to the same recipient queues once. */
    idempotencyKey: text("idempotency_key"),
    /**
     * A family SMS the school's plan lets go by WhatsApp (WAB-01): set when its usage is recorded. The
     * dispatcher sends it by WhatsApp when the number has opted in, else (or on any failure) by SMS.
     */
    whatsappAllowed: boolean("whatsapp_allowed").notNull().default(false),
    /** How an SMS-channel message actually went: "sms" or "whatsapp" (null until sent). */
    sentVia: text("sent_via", { enum: ["sms", "whatsapp"] }),
    /** Handset receipts (NOT-07), from the provider's verified webhook (WhatsApp only for now). */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("notification_outbox_due_idx").on(t.status, t.nextAttemptAt),
    index("notification_outbox_provider_message_idx").on(t.providerMessageId),
    uniqueIndex("notification_outbox_idempotency_unique")
      .on(t.channel, t.recipient, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    check("notification_outbox_segments", sql`${t.segments} between 1 and 20`),
  ],
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
    /** The school's Mobile Money provider (PAY-06): "paystack", "mock" or "none"; null: the deployment's default. */
    mobileMoneyProvider: text("mobile_money_provider", { enum: ["paystack", "mock", "none"] }),
    billingNotes: text("billing_notes"),
    /**
     * Price per term by school size, copied from the plan (so changing a plan never changes schools already on
     * it). Used for invoices unless the school has an agreed price (price_pesewas).
     */
    priceBands: jsonb("price_bands").$type<PriceBand[]>(),
    /** A discount on the plan and add-ons, in basis points (2000 = 20%), until a date (inclusive) or open. */
    discountBp: integer("discount_bp"),
    discountUntil: date("discount_until", { mode: "string" }),
    /** What the discount is called on invoices, like "Founding school". */
    discountLabel: text("discount_label"),
    /** The preset the plan was last set from (SUB-01); the plan is a copy, so editing a preset changes nothing here. */
    planPresetId: uuid("plan_preset_id"),
    /** True when the status was last changed by the automatic rules (SUB-05), false when set by platform staff. */
    statusAuto: boolean("status_auto").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    check("tenant_entitlements_max_campuses_range", sql`${t.maxCampuses} between 1 and 1000`),
    check(
      "tenant_entitlements_max_students_range",
      sql`${t.maxStudents} is null or ${t.maxStudents} between 1 and 1000000`,
    ),
    check("tenant_entitlements_features_valid", sql`${t.features} <@ ${PLAN_MODULES_SQL}`),
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
      "tenant_entitlements_mobile_money_provider",
      sql`${t.mobileMoneyProvider} is null or ${t.mobileMoneyProvider} in ('paystack', 'mock', 'none')`,
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
    /** What the child is called day to day, when different from the legal first name. */
    preferredName: text("preferred_name"),
    sex: text("sex", { enum: ["female", "male"] }).notNull(),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    admittedOn: date("admitted_on", { mode: "string" }),
    status: text("status", { enum: STUDENT_STATUSES }).notNull().default("active"),
    /** When the status last changed (with the reason in left_reason for non-active statuses). */
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    /** The student's photograph (a stored file), shown to staff who can see the student. */
    photoFileId: uuid("photo_file_id"),
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
    /** When the school last sent this guardian an invitation to the parent view (PAR-01). */
    portalInvitedAt: timestamp("portal_invited_at", { withTimezone: true }),
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
    /** SIS-04 flags. */
    isFeePayer: boolean("is_fee_payer").notNull().default(false),
    isEmergencyContact: boolean("is_emergency_contact").notNull().default(false),
    canPickUp: boolean("can_pick_up").notNull().default(false),
    /** False: this guardian gets no announcements or reminders by SMS (receipts and codes still go). */
    receivesMessages: boolean("receives_messages").notNull().default(true),
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
export const FEE_CATEGORIES = [
  "tuition",
  "admission",
  "examination",
  "transport",
  "boarding",
  "feeding",
  "uniform",
  "books",
  "levy",
  "other",
] as const;

export const feeItems = pgTable(
  "fee_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: citext("name").notNull(),
    /** What kind of fee it is, for reports (billed by category). */
    category: text("category", { enum: FEE_CATEGORIES }).notNull().default("other"),
    /** Optional items (e.g. transport, feeding) are billed only to students who take them. */
    optional: boolean("optional").notNull().default(false),
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
  "refund",
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
      sql`(${t.kind} in ('charge', 'refund') and ${t.amountPesewas} > 0)
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
    /** The provisional receipt given while offline (e.g. "P-7F3A-0004"), when the payment was taken offline. */
    provisionalReference: text("provisional_reference"),
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
    unique("payments_tenant_provisional_unique").on(t.tenantId, t.provisionalReference),
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
    /** pending: above the school's approval threshold, waiting for the Proprietor (not billed until approved). */
    status: text("status", { enum: ["pending", "active", "ended"] })
      .notNull()
      .default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
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
    /** The school's currency when the prompt was sent (Africa-wide: any currency the provider collects). */
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
    check("mobile_money_requests_currency", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    // Any country's mobile number in E.164; the service checks it against the school's country.
    check("mobile_money_requests_msisdn", sql`${t.msisdn} ~ '^[+][1-9][0-9]{7,14}$'`),
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
 * Web push on a parent's phone (R3-2, PSH-01). Tied to the parent sign-in it was turned on in: when that
 * session ends (sign-out or expiry) the subscription goes with it, so a shared phone stops receiving the
 * family's notifications. Global like parent sessions: which schools may notify it is worked out from each
 * school's guardian records when sending. Removed too when the push service says it no longer exists.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** A family phone: the parent sign-in it belongs to and that number. */
    parentSessionId: text("parent_session_id").references(() => parentSessions.id, { onDelete: "cascade" }),
    phone: text("phone"),
    /** A staff device (PSH-01): the staff sign-in it belongs to and that member; ends with the sign-in. */
    staffSessionId: text("staff_session_id").references(() => sessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  },
  (t) => [
    index("push_subscriptions_phone_idx").on(t.phone),
    index("push_subscriptions_user_idx").on(t.userId),
    check("push_subscriptions_phone", sql`${t.phone} is null or ${t.phone} ~ '^[+][1-9][0-9]{7,14}$'`),
    check(
      "push_subscriptions_owner",
      sql`(${t.parentSessionId} is not null and ${t.phone} is not null and ${t.staffSessionId} is null and ${t.userId} is null) or (${t.parentSessionId} is null and ${t.phone} is null and ${t.staffSessionId} is not null and ${t.userId} is not null)`,
    ),
    check(
      "push_subscriptions_endpoint",
      sql`${t.endpoint} ~ '^https://' and char_length(${t.endpoint}) <= 1000`,
    ),
    check("push_subscriptions_keys", sql`char_length(${t.p256dh}) <= 200 and char_length(${t.auth}) <= 100`),
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
      enum: [
        "fee_reminder",
        "parent_code",
        "absence_alert",
        "payment_receipt",
        "announcement",
        "portal_invitation",
        "fees_billed",
        "application_code",
        "consent_request",
        "event_reminder",
      ],
    }).notNull(),
    /** The student the message was about (for each student's message history); null for codes and announcements. */
    studentId: uuid("student_id"),
    outboxId: uuid("outbox_id")
      .notNull()
      .references(() => notificationOutbox.id, { onDelete: "restrict" }),
    sharedWith: integer("shared_with").notNull().default(1),
    /** SMS segments charged, copied from the queued message by a trigger (never trusted from the caller). */
    segments: integer("segments").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("sms_usage_outbox_tenant_unique").on(t.outboxId, t.tenantId),
    check("sms_usage_segments", sql`${t.segments} between 1 and 20`),
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
    /** Who issued it; null for an invoice issued automatically each period. */
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    /** Issued automatically for its period (src/server/billing/auto-invoices.ts), once per period. */
    automatic: boolean("automatic").notNull().default(false),
    /** Active students it was priced for (the census count), when priced by size. */
    studentCount: integer("student_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("subscription_invoices_tenant_idx").on(t.tenantId, t.issuedOn),
    check("subscription_invoices_issuer", sql`${t.automatic} or ${t.createdByUserId} is not null`),
    check("subscription_invoices_total_range", sql`${t.totalPesewas} between 1 and 1000000000`),
    check("subscription_invoices_period", sql`${t.periodEndsOn} >= ${t.periodStartsOn}`),
    check("subscription_invoices_due", sql`${t.dueOn} >= ${t.issuedOn}`),
    check("subscription_invoices_paid_or_void", sql`${t.paidOn} is null or ${t.voidedAt} is null`),
    check("subscription_invoices_void_reason", sql`(${t.voidedAt} is null) = (${t.voidReason} is null)`),
    check("subscription_invoices_currency_format", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * A school's active students on its census day for a term (founder, 2026-11-18): what its plan is priced on for
 * that term, whatever the billing period. Counted once and never changed.
 */
export const subscriptionCensus = pgTable(
  "subscription_census",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    termId: uuid("term_id").notNull(),
    countedOn: date("counted_on", { mode: "string" }).notNull(),
    activeStudents: integer("active_students").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("subscription_census_term_unique").on(t.tenantId, t.termId),
    foreignKey({
      name: "subscription_census_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }).onDelete("restrict"),
    check("subscription_census_count", sql`${t.activeStudents} between 0 and 1000000`),
  ],
);

/**
 * Extra SMS for a month, added by EduBridge staff when a school asks (founder, 2026-11-18): they raise that
 * month's allowance and are charged on the school's next invoice.
 */
export const smsTopUps = pgTable(
  "sms_top_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** The month the messages are for, like "2026-11" (the school's calendar). */
    month: text("month").notNull(),
    messages: integer("messages").notNull(),
    pricePesewas: bigint("price_pesewas", { mode: "number" }).notNull(),
    currencyCode: text("currency_code").notNull(),
    /** The invoice that charged it; null until then. */
    invoiceId: uuid("invoice_id").references(() => subscriptionInvoices.id, { onDelete: "restrict" }),
    addedByUserId: uuid("added_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sms_top_ups_tenant_idx").on(t.tenantId, t.month),
    check("sms_top_ups_month", sql`${t.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check("sms_top_ups_messages", sql`${t.messages} between 1 and 1000000`),
    check("sms_top_ups_price", sql`${t.pricePesewas} between 0 and 1000000000`),
    check("sms_top_ups_currency_format", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
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
    /** The AI model, for whichever provider is chosen (R5-4). */
    assistantModel: text("assistant_model").notNull().default("claude-opus-5-5"),
    /** The AI gateway (R5-4, AIG-01, AIG-02): one switch for every AI task, and the provider behind it. */
    aiEnabled: boolean("ai_enabled").notNull().default(false),
    aiProvider: text("ai_provider").notNull().default("none"),
    /** The address of an OpenAI-compatible provider (Ollama or another); null for a provider's own address. */
    aiBaseUrl: text("ai_base_url"),
    /** Platform staff recorded that the data-protection review allows identifiable data (paid providers only). */
    aiIdentifiableApproved: boolean("ai_identifiable_approved").notNull().default(false),
    /** Limits (AIG-03); schools may be given their own monthly allowance (ai_school_limits). */
    aiPlatformMonthlyTokens: integer("ai_platform_monthly_tokens").notNull().default(5_000_000),
    aiSchoolMonthlyTokens: integer("ai_school_monthly_tokens").notNull().default(500_000),
    aiUserPerMinute: integer("ai_user_per_minute").notNull().default(4),
    aiUserPerHour: integer("ai_user_per_hour").notNull().default(30),
    aiUserDailyTokens: integer("ai_user_daily_tokens").notNull().default(100_000),
    aiMaxOutputTokens: integer("ai_max_output_tokens").notNull().default(1_500),
    /** Price per WhatsApp message charged to schools billed in cedis (WAB-01); null: not set. */
    whatsappPricePesewas: bigint("whatsapp_price_pesewas", { mode: "number" }),
    /** EduBridge as it appears on invoices (SUB-03): legal name, address, tax number. */
    invoiceIssuerDetails: text("invoice_issuer_details"),
    /** How schools pay EduBridge's invoices (bank or Mobile Money details), printed on each invoice. */
    invoicePaymentInstructions: text("invoice_payment_instructions"),
    /** Days a module stays read-only after a school's add-on, trial or promotion ends (ENT-08, D-R4-5). */
    moduleReadOnlyDays: integer("module_read_only_days").notNull().default(90),
    /** Automatic invoices each period (founder, 2026-11-18): off until prices are set and checked. */
    autoInvoicing: boolean("auto_invoicing").notNull().default(false),
    /** Students are counted this many days after a term starts (the census day). */
    censusDays: integer("census_days").notNull().default(21),
    /** Days a school has to pay an invoice. */
    invoiceDueDays: integer("invoice_due_days").notNull().default(30),
    /** Off a year's terms when paying yearly, and on a month's share when paying monthly, in basis points. */
    annualDiscountBp: integer("annual_discount_bp").notNull().default(1200),
    monthlySurchargeBp: integer("monthly_surcharge_bp").notNull().default(1000),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    check("platform_settings_single_row", sql`${t.id}`),
    check("platform_settings_grace_range", sql`${t.graceDays} between 0 and 60`),
    check("platform_settings_read_only_days_range", sql`${t.moduleReadOnlyDays} between 0 and 365`),
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
    /** The Proprietor's switch for the school assistant (also needs the plan module and the platform switch). */
    assistantEnabled: boolean("assistant_enabled").notNull().default(false),
    /** Whether student and staff names may be sent to the assistant's provider (otherwise replaced by references). */
    assistantShareNames: boolean("assistant_share_names").notNull().default(false),
    /** The Proprietor allows Accountants to take payments without a connection (provisional receipts). */
    offlineReceiptsEnabled: boolean("offline_receipts_enabled").notNull().default(false),
    /** Discounts above this percentage (basis points) need the Proprietor's approval; null: none needed. */
    discountApprovalBasisPoints: integer("discount_approval_basis_points"),
    /** Fixed discounts above this amount need the Proprietor's approval; null: none needed. */
    discountApprovalPesewas: bigint("discount_approval_pesewas", { mode: "number" }),
    /** School identity (TEN-04): accent colour (#rrggbb, contrast-checked) and logo (a stored file). */
    brandColor: text("brand_color"),
    logoFileId: uuid("logo_file_id"),
    /** Admission numbers: optional prefix (e.g. "KR/") and how many digits. */
    admissionPrefix: text("admission_prefix"),
    admissionDigits: integer("admission_digits").notNull().default(4),
    /** Starter template for levels, subjects and grading (src/lib/curricula.ts); null: the country's. */
    curriculumTemplate: text("curriculum_template"),
    /**
     * How teachers are assigned (per school): "class", class teachers enter every subject's marks for their
     * class; "subject", subject teachers enter marks for the subjects they are given in each class, and the
     * class teacher keeps the register, remarks and any subject without a subject teacher.
     */
    teachingModel: text("teaching_model", { enum: ["class", "subject"] })
      .notNull()
      .default("class"),
    /** Report-card layout (src/lib/report-styles.ts); null: the one that suits the school's template. */
    reportCardStyle: text("report_card_style", { enum: REPORT_CARD_STYLES }),
    /** Whether teachers take a register in each timetabled lesson, as well as the daily class register. */
    lessonAttendance: boolean("lesson_attendance").notNull().default(false),
    /** Families may apply online (ADM-02); off by default, as each phone check costs the school an SMS. */
    onlineApplications: boolean("online_applications").notNull().default(false),
    /** Admission fees charged on enrolment, set by finance staff and frozen into each offer. */
    admissionFees: jsonb("admission_fees").$type<AdmissionFee[]>().notNull().default([]),
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
    /** Families notified on their phones by web push instead (free; R3-2). */
    pushCount: integer("push_count").notNull().default(0),
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
    /** Figures in the answer not found in what the tools returned (R5-4, AST-01a); empty when all checked. */
    uncheckedFigures: jsonb("unchecked_figures").$type<string[]>().notNull().default([]),
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

/**
 * Secrets EduBridge staff manage in the app (e.g. the assistant provider's API key), sealed with the
 * application encryption key (MFA_ENCRYPTION_KEY). Only a hint (the last four characters) is ever shown.
 */
export const platformSecrets = pgTable("platform_secrets", {
  name: text("name").primaryKey(),
  sealed: text("sealed").notNull(),
  hint: text("hint").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
});

/**
 * Keys that sign learner records (Transfer Passport), generated in the app by EduBridge staff. One key is
 * active (new records); retired keys stay so records they signed still verify. Private keys are sealed.
 */
export const recordSigningKeys = pgTable(
  "record_signing_keys",
  {
    keyId: text("key_id").primaryKey(),
    /** Ed25519 public key, SPKI DER in base64 (published for verification). */
    publicKey: text("public_key").notNull(),
    privateKeySealed: text("private_key_sealed").notNull(),
    status: text("status", { enum: ["active", "retired"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("record_signing_keys_one_active")
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
  ],
);

/** What EduBridge staff did to platform-wide settings and secrets (insert-only). */
export const platformEvents = pgTable(
  "platform_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("platform_events_time_idx").on(t.occurredAt)],
);

/**
 * Closing the books (FIN-16): no ledger entry or payment may be dated on or before the latest
 * `locked_through` (enforced by a database trigger). Each change is a new row, so the history of closing
 * and reopening is kept; reopening is the Proprietor's alone and needs a reason.
 */
export const financePeriodLocks = pgTable(
  "finance_period_locks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** Null: nothing locked (after reopening everything). */
    lockedThrough: date("locked_through", { mode: "string" }),
    reason: text("reason"),
    setByUserId: uuid("set_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("finance_period_locks_tenant_idx").on(t.tenantId, t.setAt)],
);

export const REFUND_STATUSES = ["requested", "approved", "rejected", "paid", "cancelled"] as const;

/**
 * Refunds of a family's credit (FIN-10): requested, approved (by a second finance user when the school
 * has more than one), then paid out, which posts a `refund` ledger entry and takes the next refund number.
 */
export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    studentId: uuid("student_id").notNull(),
    refundNumber: text("refund_number"),
    amountPesewas: bigint("amount_pesewas", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    status: text("status", { enum: REFUND_STATUSES }).notNull().default("requested"),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    paidByUserId: uuid("paid_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    paidOn: date("paid_on", { mode: "string" }),
    method: text("method", { enum: PAYMENT_METHODS }),
    reference: text("reference"),
    ledgerEntryId: uuid("ledger_entry_id"),
  },
  (t) => [
    index("refunds_tenant_idx").on(t.tenantId, t.status),
    unique("refunds_tenant_number_unique").on(t.tenantId, t.refundNumber),
    foreignKey({
      name: "refunds_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    check("refunds_amount_range", sql`${t.amountPesewas} between 1 and 1000000000`),
    check("refunds_reason_length", sql`char_length(${t.reason}) between 3 and 300`),
    check(
      "refunds_paid_fields",
      sql`(${t.status} = 'paid') = (${t.paidOn} is not null and ${t.ledgerEntryId} is not null)`,
    ),
  ],
);

/** Optional fee items a student takes (e.g. transport): billing adds these items for them only. */
export const studentFeeOptions = pgTable(
  "student_fee_options",
  {
    tenantId: uuid("tenant_id").notNull(),
    studentId: uuid("student_id").notNull(),
    feeItemId: uuid("fee_item_id").notNull(),
    addedByUserId: uuid("added_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.studentId, t.feeItemId] }),
    foreignKey({
      name: "student_fee_options_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: "student_fee_options_item_fk",
      columns: [t.tenantId, t.feeItemId],
      foreignColumns: [feeItems.tenantId, feeItems.id],
    }),
  ],
);

export const FILE_PURPOSES = [
  "school_logo",
  "student_photo",
  "student_document",
  "payment_evidence",
  "staff_document",
  // Checked with the same rules, but stored in safeguarding_documents (lead-only), never in stored_files.
  "safeguarding_document",
  // A named collector's photo (VIS-02a), shown to staff releasing the child.
  "collector_photo",
] as const;

/**
 * Files a school uploads (logo, student photos, student documents, payment evidence), stored privately in
 * the database and served only through routes that check the person's access (and log document downloads).
 * Never deleted by the app: a removed file is marked removed and no longer served.
 */
export const storedFiles = pgTable(
  "stored_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    purpose: text("purpose", { enum: FILE_PURPOSES }).notNull(),
    /** The student or payment it belongs to (null for the school logo). */
    ownerId: uuid("owner_id"),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    content: bytea("content").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedByUserId: uuid("removed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("stored_files_owner_idx").on(t.tenantId, t.purpose, t.ownerId),
    check("stored_files_size", sql`${t.sizeBytes} between 1 and 5242880`),
    check("stored_files_filename_length", sql`char_length(${t.filename}) between 1 and 200`),
  ],
);

/**
 * Medical and emergency information (SIS-06): only for roles allowed to see it, and every view and change is
 * recorded in the audit log.
 */
export const studentMedical = pgTable(
  "student_medical",
  {
    tenantId: uuid("tenant_id").notNull(),
    studentId: uuid("student_id").primaryKey(),
    bloodGroup: text("blood_group"),
    allergies: text("allergies"),
    conditions: text("conditions"),
    medications: text("medications"),
    doctorName: text("doctor_name"),
    doctorPhone: text("doctor_phone"),
    emergencyNotes: text("emergency_notes"),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "student_medical_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);

export const RECONCILIATION_DIFFERENCES = [
  "not_recorded",
  "not_confirmed",
  "amount_differs",
  "voided_but_paid",
] as const;

/**
 * Daily reconciliation (PAY-04): once a day each school's Mobile Money requests of the previous day are
 * checked again with the provider and compared with the payments EduBridge recorded. One run per school,
 * provider and day; differences are listed for the Accountant and never corrected automatically.
 */
export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    /** The school day whose requests were checked. */
    runDate: date("run_date", { mode: "string" }).notNull(),
    checked: integer("checked").notNull().default(0),
    matched: integer("matched").notNull().default(0),
    differences: integer("differences").notNull().default(0),
    /** Requests the provider could not be asked about (checked again the next day). */
    errors: integer("errors").notNull().default(0),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("reconciliation_runs_tenant_id_unique").on(t.tenantId, t.id),
    unique("reconciliation_runs_day_unique").on(t.tenantId, t.provider, t.runDate),
  ],
);

export const reconciliationItems = pgTable(
  "reconciliation_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    runId: uuid("run_id").notNull(),
    requestId: uuid("request_id").notNull(),
    difference: text("difference", { enum: RECONCILIATION_DIFFERENCES }).notNull(),
    /** What was found, safe to show staff. */
    detail: text("detail").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "reconciliation_items_run_fk",
      columns: [t.tenantId, t.runId],
      foreignColumns: [reconciliationRuns.tenantId, reconciliationRuns.id],
    }),
    foreignKey({
      name: "reconciliation_items_request_fk",
      columns: [t.tenantId, t.requestId],
      foreignColumns: [mobileMoneyRequests.tenantId, mobileMoneyRequests.id],
    }),
    unique("reconciliation_items_run_request_unique").on(t.runId, t.requestId),
    index("reconciliation_items_open_idx").on(t.tenantId, t.reviewedAt),
  ],
);

/**
 * Subject teachers (teaching model "subject"): who teaches a subject in a class. One teacher per subject per
 * class; one teacher can teach the same subject in many classes, so neither teachers nor subjects are ever
 * duplicated. Kept when a school switches back to class teachers, so switching again loses nothing.
 */
export const subjectTeachers = pgTable(
  "subject_teachers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    classId: uuid("class_id").notNull(),
    subjectId: uuid("subject_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "subject_teachers_class_fk",
      columns: [t.tenantId, t.classId],
      foreignColumns: [classes.tenantId, classes.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "subject_teachers_subject_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "subject_teachers_membership_fk",
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    unique("subject_teachers_class_subject_unique").on(t.tenantId, t.classId, t.subjectId),
    index("subject_teachers_membership_idx").on(t.tenantId, t.membershipId),
  ],
);

/**
 * The school day (timetables): lesson periods and breaks in order, e.g. "Period 1, 08:00–08:40". Shared by
 * every class. A period used by a lesson register cannot be removed (its times can still change).
 */
export const timetablePeriods = pgTable(
  "timetable_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: citext("name").notNull(),
    /** School-local times, "HH:MM". */
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
    kind: text("kind", { enum: ["lesson", "break"] })
      .notNull()
      .default("lesson"),
    ...timestamps,
  },
  (t) => [
    unique("timetable_periods_tenant_id_unique").on(t.tenantId, t.id),
    unique("timetable_periods_name_unique").on(t.tenantId, t.name),
    check("timetable_periods_name_length", sql`char_length(${t.name}) between 1 and 40`),
    check(
      "timetable_periods_times",
      sql`${t.startsAt} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.endsAt} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.endsAt} > ${t.startsAt}`,
    ),
  ],
);

/**
 * A class's timetable for a term: one lesson per weekday and period, with its subject and teacher. A teacher
 * is never in two classes at once (unique index on teacher, weekday and period for the term).
 */
export const timetableLessons = pgTable(
  "timetable_lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    termId: uuid("term_id").notNull(),
    classId: uuid("class_id").notNull(),
    /** ISO weekday: 1 Monday … 7 Sunday. */
    weekday: integer("weekday").notNull(),
    periodId: uuid("period_id").notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** The teacher (a staff membership), or null when not yet decided. */
    membershipId: uuid("membership_id"),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "timetable_lessons_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "timetable_lessons_class_fk",
      columns: [t.tenantId, t.classId],
      foreignColumns: [classes.tenantId, classes.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "timetable_lessons_period_fk",
      columns: [t.tenantId, t.periodId],
      foreignColumns: [timetablePeriods.tenantId, timetablePeriods.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "timetable_lessons_subject_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    foreignKey({
      name: "timetable_lessons_membership_fk",
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    unique("timetable_lessons_slot_unique").on(t.tenantId, t.termId, t.classId, t.weekday, t.periodId),
    uniqueIndex("timetable_lessons_teacher_slot_unique")
      .on(t.tenantId, t.termId, t.membershipId, t.weekday, t.periodId)
      .where(sql`${t.membershipId} is not null`),
    check("timetable_lessons_weekday", sql`${t.weekday} between 1 and 7`),
  ],
);

/**
 * A lesson register: who was in one timetabled lesson on one day (lesson attendance, when the school turns
 * it on). The subject and teacher are recorded as they were, so later timetable changes never alter it.
 */
export const lessonRegisters = pgTable(
  "lesson_registers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    classId: uuid("class_id").notNull(),
    termId: uuid("term_id").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    periodId: uuid("period_id").notNull(),
    subjectId: uuid("subject_id").notNull(),
    teacherMembershipId: uuid("teacher_membership_id"),
    takenByUserId: uuid("taken_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "lesson_registers_class_fk",
      columns: [t.tenantId, t.classId],
      foreignColumns: [classes.tenantId, classes.id],
    }),
    foreignKey({
      name: "lesson_registers_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    foreignKey({
      name: "lesson_registers_period_fk",
      columns: [t.tenantId, t.periodId],
      foreignColumns: [timetablePeriods.tenantId, timetablePeriods.id],
    }),
    foreignKey({
      name: "lesson_registers_subject_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    foreignKey({
      name: "lesson_registers_teacher_fk",
      columns: [t.tenantId, t.teacherMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    unique("lesson_registers_slot_unique").on(t.tenantId, t.classId, t.date, t.periodId),
    unique("lesson_registers_tenant_id_unique").on(t.tenantId, t.id),
    index("lesson_registers_term_idx").on(t.tenantId, t.termId, t.subjectId),
  ],
);

/** One student's mark in a lesson register, versioned like class register marks. */
export const lessonMarks = pgTable(
  "lesson_marks",
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
      name: "lesson_marks_register_fk",
      columns: [t.tenantId, t.registerId],
      foreignColumns: [lessonRegisters.tenantId, lessonRegisters.id],
    }),
    foreignKey({
      name: "lesson_marks_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete("cascade"),
    unique("lesson_marks_register_student_unique").on(t.registerId, t.studentId),
    unique("lesson_marks_tenant_id_unique").on(t.tenantId, t.id),
    index("lesson_marks_student_idx").on(t.tenantId, t.studentId),
    check("lesson_marks_reason_length", sql`coalesce(char_length(${t.reason}), 0) <= 120`),
    check("lesson_marks_version", sql`${t.version} >= 1`),
  ],
);

/** Every change to a lesson mark (insert-only), as for class registers. */
export const lessonMarkChanges = pgTable(
  "lesson_mark_changes",
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
      name: "lesson_mark_changes_mark_fk",
      columns: [t.tenantId, t.markId],
      foreignColumns: [lessonMarks.tenantId, lessonMarks.id],
    }).onDelete("cascade"),
    index("lesson_mark_changes_mark_idx").on(t.tenantId, t.markId),
  ],
);

/**
 * A subject teacher's comment on one student's subject for a term (shown on report cards). Locked, like
 * marks, while the student's report card for the term is published.
 */
export const subjectComments = pgTable(
  "subject_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    termId: uuid("term_id").notNull(),
    studentId: uuid("student_id").notNull(),
    subjectId: uuid("subject_id").notNull(),
    comment: text("comment").notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "subject_comments_term_fk",
      columns: [t.tenantId, t.termId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    foreignKey({
      name: "subject_comments_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "subject_comments_subject_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    unique("subject_comments_unique").on(t.tenantId, t.termId, t.studentId, t.subjectId),
    check("subject_comments_length", sql`char_length(${t.comment}) between 1 and 400`),
  ],
);

/**
 * An applicant (R3-4, ADM-01 to ADM-08): from inquiry to enrolment, kept apart from students (D-R3-1).
 * Enrolling creates the student and posts the offer's admission fees to the ledger in one transaction.
 * Declined and withdrawn applications lose their personal details 12 months after the decision (D-R3-2):
 * names, contact and notes are cleared and `erased_at` set; level, term, source and dates stay for reports.
 */
export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    reference: text("reference").notNull(),
    status: text("status", { enum: APPLICATION_STATUSES }).notNull().default("inquiry"),
    source: text("source", { enum: APPLICATION_SOURCES }).notNull(),
    childFirstName: text("child_first_name"),
    childOtherNames: text("child_other_names"),
    childLastName: text("child_last_name"),
    sex: text("sex", { enum: ["female", "male"] }),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    previousSchool: text("previous_school"),
    levelId: uuid("level_id").notNull(),
    entryTermId: uuid("entry_term_id"),
    guardianName: text("guardian_name"),
    guardianPhone: text("guardian_phone"),
    guardianEmail: text("guardian_email"),
    guardianRelationship: text("guardian_relationship"),
    notes: text("notes"),
    assessmentAt: timestamp("assessment_at", { withTimezone: true }),
    assessmentNote: text("assessment_note"),
    offeredAt: timestamp("offered_at", { withTimezone: true }),
    offerClassId: uuid("offer_class_id"),
    offerRespondBy: date("offer_respond_by", { mode: "string" }),
    /** Admission fees frozen when the offer is made; posted to the new student's account on enrolment. */
    offerFees: jsonb("offer_fees").$type<AdmissionFee[]>(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    studentId: uuid("student_id"),
    erasedAt: timestamp("erased_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    unique("applications_tenant_id_unique").on(t.tenantId, t.id),
    unique("applications_reference_unique").on(t.tenantId, t.reference),
    unique("applications_student_unique").on(t.tenantId, t.studentId),
    foreignKey({
      name: "applications_level_fk",
      columns: [t.tenantId, t.levelId],
      foreignColumns: [levels.tenantId, levels.id],
    }),
    foreignKey({
      name: "applications_term_fk",
      columns: [t.tenantId, t.entryTermId],
      foreignColumns: [terms.tenantId, terms.id],
    }),
    foreignKey({
      name: "applications_class_fk",
      columns: [t.tenantId, t.offerClassId],
      foreignColumns: [classes.tenantId, classes.id],
    }),
    foreignKey({
      name: "applications_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    index("applications_status_idx").on(t.tenantId, t.status, t.createdAt),
    index("applications_phone_idx").on(t.tenantId, t.guardianPhone),
    check(
      "applications_personal_details",
      sql`${t.erasedAt} is not null or (${t.childFirstName} is not null and ${t.childLastName} is not null and ${t.guardianName} is not null)`,
    ),
    check(
      "applications_text_lengths",
      sql`coalesce(char_length(${t.childFirstName}), 0) <= 60 and coalesce(char_length(${t.childOtherNames}), 0) <= 60 and coalesce(char_length(${t.childLastName}), 0) <= 60 and coalesce(char_length(${t.guardianName}), 0) <= 120 and coalesce(char_length(${t.previousSchool}), 0) <= 120 and coalesce(char_length(${t.notes}), 0) <= 1000 and coalesce(char_length(${t.assessmentNote}), 0) <= 500`,
    ),
    check(
      "applications_phone",
      sql`${t.guardianPhone} is null or ${t.guardianPhone} ~ '^[+][1-9][0-9]{7,14}$'`,
    ),
    check("applications_enrolled_student", sql`(${t.status} = 'enrolled') = (${t.studentId} is not null)`),
  ],
);

/** Every change of an application's status, with who and why (insert-only). */
export const applicationEvents = pgTable(
  "application_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    fromStatus: text("from_status", { enum: APPLICATION_STATUSES }),
    toStatus: text("to_status", { enum: APPLICATION_STATUSES }).notNull(),
    note: text("note"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "application_events_application_fk",
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
    }),
    index("application_events_application_idx").on(t.tenantId, t.applicationId, t.createdAt),
    check("application_events_note_length", sql`coalesce(char_length(${t.note}), 0) <= 500`),
  ],
);

/**
 * An online application waiting for its phone to be confirmed by SMS code (ADM-02). Nothing becomes an
 * application until the code is entered; the draft is cleared once used, and rows are purged after a day.
 */
export const applicationVerifications = pgTable(
  "application_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    draft: jsonb("draft").$type<Record<string, unknown>>(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ipAddress: inet("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "application_verifications_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete("cascade"),
    index("application_verifications_phone_idx").on(t.tenantId, t.phone, t.createdAt),
    index("application_verifications_created_idx").on(t.createdAt),
    check("application_verifications_phone", sql`${t.phone} ~ '^[+][1-9][0-9]{7,14}$'`),
  ],
);

/**
 * A school event (EVT-01): for the whole school, a campus, a level or a class, on one day or several, with
 * school-local times. Shown in the parent view; families can be reminded before it. Edited while it is
 * coming; cancelled rather than deleted (trigger).
 */
export const schoolEvents = pgTable(
  "school_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    details: text("details"),
    location: text("location"),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    /** School-local times, "HH:MM"; none for an all-day event. */
    startTime: text("start_time"),
    endTime: text("end_time"),
    audience: text("audience", { enum: ["school", "level", "class", "campus"] }).notNull(),
    audienceId: uuid("audience_id"),
    reminder: text("reminder", { enum: EVENT_REMINDERS }).notNull().default("none"),
    reminderDaysBefore: integer("reminder_days_before").notNull().default(1),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    reminderSmsCount: integer("reminder_sms_count").notNull().default(0),
    reminderPushCount: integer("reminder_push_count").notNull().default(0),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    unique("school_events_tenant_id_unique").on(t.tenantId, t.id),
    index("school_events_tenant_idx").on(t.tenantId, t.startsOn),
    check("school_events_title_length", sql`char_length(${t.title}) between 2 and 100`),
    check(
      "school_events_text_lengths",
      sql`coalesce(char_length(${t.details}), 0) <= 2000 and coalesce(char_length(${t.location}), 0) <= 120`,
    ),
    check("school_events_dates", sql`${t.endsOn} >= ${t.startsOn} and ${t.endsOn} - ${t.startsOn} <= 60`),
    check(
      "school_events_times",
      sql`(${t.startTime} is null or ${t.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') and (${t.endTime} is null or (${t.startTime} is not null and ${t.endTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and (${t.endsOn} > ${t.startsOn} or ${t.endTime} > ${t.startTime})))`,
    ),
    check("school_events_audience_id", sql`(${t.audience} = 'school') = (${t.audienceId} is null)`),
    check("school_events_reminder_days", sql`${t.reminderDaysBefore} between 1 and 14`),
  ],
);

/**
 * A consent form (CNS-01): the school's own wording, attached to an event or on its own, for an audience,
 * with a deadline (the last school-local day answers are taken). The wording and audience never change once
 * created (column grants); the deadline can move, and a form is cancelled rather than deleted.
 */
export const consentForms = pgTable(
  "consent_forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    eventId: uuid("event_id"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    deadline: date("deadline", { mode: "string" }).notNull(),
    audience: text("audience", { enum: ["school", "level", "class", "campus"] }).notNull(),
    audienceId: uuid("audience_id"),
    /** Families told about the form so far (on creation and by reminders). */
    smsCount: integer("sms_count").notNull().default(0),
    pushCount: integer("push_count").notNull().default(0),
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    unique("consent_forms_tenant_id_unique").on(t.tenantId, t.id),
    foreignKey({
      name: "consent_forms_event_fk",
      columns: [t.tenantId, t.eventId],
      foreignColumns: [schoolEvents.tenantId, schoolEvents.id],
    }),
    index("consent_forms_tenant_idx").on(t.tenantId, t.deadline),
    check("consent_forms_title_length", sql`char_length(${t.title}) between 2 and 100`),
    check("consent_forms_body_length", sql`char_length(${t.body}) between 1 and 4000`),
    check("consent_forms_audience_id", sql`(${t.audience} = 'school') = (${t.audienceId} is null)`),
  ],
);

/**
 * A guardian's answer to a consent form for one child (insert-only: the latest answer per child counts).
 * From the parent view it carries the verified number used; from the office (a paper slip) the member who
 * recorded it.
 */
export const consentAnswers = pgTable(
  "consent_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    formId: uuid("form_id").notNull(),
    studentId: uuid("student_id").notNull(),
    guardianId: uuid("guardian_id").notNull(),
    answer: text("answer", { enum: CONSENT_ANSWERS }).notNull(),
    note: text("note"),
    source: text("source", { enum: ["parent_view", "office"] }).notNull(),
    phone: text("phone"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "consent_answers_form_fk",
      columns: [t.tenantId, t.formId],
      foreignColumns: [consentForms.tenantId, consentForms.id],
    }),
    foreignKey({
      name: "consent_answers_student_fk",
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: "consent_answers_guardian_fk",
      columns: [t.tenantId, t.guardianId],
      foreignColumns: [guardians.tenantId, guardians.id],
    }),
    index("consent_answers_form_idx").on(t.tenantId, t.formId, t.studentId, t.createdAt),
    check("consent_answers_note_length", sql`coalesce(char_length(${t.note}), 0) <= 300`),
    check(
      "consent_answers_source",
      sql`(${t.source} = 'parent_view' and ${t.phone} ~ '^[+][1-9][0-9]{7,14}$' and ${t.recordedByUserId} is null) or (${t.source} = 'office' and ${t.phone} is null and ${t.recordedByUserId} is not null)`,
    ),
  ],
);

/**
 * A plan EduBridge offers (SUB-01): what it includes, its limits and its usual price. A school's plan starts
 * from one (copied into tenant_entitlements). Platform staff edit and archive presets; none is deleted.
 */
export const planPresets = pgTable(
  "plan_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: citext("name").notNull().unique(),
    description: text("description"),
    features: text("features").array().notNull(),
    maxCampuses: integer("max_campuses").notNull().default(1),
    maxStudents: integer("max_students"),
    maxSmsPerMonth: integer("max_sms_per_month"),
    billingPeriod: text("billing_period", { enum: BILLING_PERIODS }).notNull().default("termly"),
    /** The usual price per billing period, in `currency_code`; applied only to schools billed in it. */
    pricePesewas: bigint("price_pesewas", { mode: "number" }),
    /** Price per term by school size (src/lib/pricing.ts), in `currency_code`; null: priced per school. */
    priceBands: jsonb("price_bands").$type<PriceBand[]>(),
    currencyCode: text("currency_code").notNull().default("GHS"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    check("plan_presets_name_length", sql`char_length(${t.name}) between 2 and 60`),
    check("plan_presets_description_length", sql`coalesce(char_length(${t.description}), 0) <= 300`),
    check("plan_presets_max_campuses", sql`${t.maxCampuses} between 1 and 1000`),
    check(
      "plan_presets_max_students",
      sql`${t.maxStudents} is null or ${t.maxStudents} between 1 and 1000000`,
    ),
    check(
      "plan_presets_max_sms",
      sql`${t.maxSmsPerMonth} is null or ${t.maxSmsPerMonth} between 0 and 1000000`,
    ),
    check("plan_presets_price", sql`${t.pricePesewas} is null or ${t.pricePesewas} between 0 and 1000000000`),
    check("plan_presets_currency", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * A school asking EduBridge to change its plan (SUB-02, D-R3-4): a preset and/or what it needs, decided once
 * by platform staff (or withdrawn by the school). One request waits at a time.
 */
export const planChangeRequests = pgTable(
  "plan_change_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    presetId: uuid("preset_id").references(() => planPresets.id, { onDelete: "restrict" }),
    message: text("message"),
    /** What is asked for (SUB-08): another plan, a module added to the plan, or an add-on cancelled. */
    kind: text("kind", { enum: ["plan", "add_module", "cancel_module"] })
      .notNull()
      .default("plan"),
    module: text("module"),
    status: text("status", { enum: PLAN_REQUEST_STATUSES }).notNull().default("pending"),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("plan_change_requests_tenant_idx").on(t.tenantId, t.createdAt),
    uniqueIndex("plan_change_requests_one_pending")
      .on(t.tenantId)
      .where(sql`${t.status} = 'pending'`),
    check(
      "plan_change_requests_what",
      sql`(${t.kind} = 'plan' and ${t.module} is null and (${t.presetId} is not null or ${t.message} is not null))
        or (${t.kind} <> 'plan' and ${t.module} is not null and ${t.presetId} is null)`,
    ),
    check(
      "plan_change_requests_module_valid",
      sql`${t.module} is null or ${t.module} = any(${PLAN_MODULES_SQL})`,
    ),
    check(
      "plan_change_requests_text_lengths",
      sql`coalesce(char_length(${t.message}), 0) <= 500 and coalesce(char_length(${t.decisionNote}), 0) <= 300`,
    ),
    check("plan_change_requests_decided", sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
  ],
);

/**
 * A module a school has beyond its plan (SUB-06, ADR 0003): an add-on, a trial, a promotion or part of an
 * agreement, with its own dates and agreed price. Written by platform staff; never deleted, and ended once
 * (a trigger allows only scheduling the end and ending it), so the rows are also the school's history.
 */
export const schoolModules = pgTable(
  "school_modules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    module: text("module").notNull(),
    source: text("source", { enum: ENTITLEMENT_SOURCES }).notNull(),
    /** First and last day included (school-local dates); no end date: until ended. */
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }),
    billingPeriod: text("billing_period", { enum: BILLING_PERIODS }),
    /** The agreed price per billing period in the school's currency; null: no charge (trials, promotions). */
    pricePesewas: bigint("price_pesewas", { mode: "number" }),
    priceUnit: text("price_unit", { enum: ["flat", "per_student"] }),
    currencyCode: text("currency_code"),
    note: text("note"),
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    endReason: text("end_reason"),
  },
  (t) => [
    index("school_modules_tenant_idx").on(t.tenantId, t.module),
    check("school_modules_module_valid", sql`${t.module} = any(${PLAN_MODULES_SQL})`),
    check("school_modules_dates", sql`${t.endsOn} is null or ${t.endsOn} >= ${t.startsOn}`),
    check(
      "school_modules_price",
      sql`(${t.pricePesewas} is null and ${t.priceUnit} is null and ${t.currencyCode} is null and ${t.billingPeriod} is null)
        or (${t.pricePesewas} between 0 and 1000000000 and ${t.priceUnit} is not null and ${t.currencyCode} ~ '^[A-Z]{3}$' and ${t.billingPeriod} is not null)`,
    ),
    check(
      "school_modules_ended",
      sql`(${t.endedAt} is null and ${t.endedByUserId} is null and ${t.endReason} is null)
        or (${t.endedAt} is not null and ${t.endedByUserId} is not null and char_length(${t.endReason}) between 3 and 300)`,
    ),
    check("school_modules_note_length", sql`coalesce(char_length(${t.note}), 0) <= 300`),
  ],
);

/**
 * Release access (REL-02): a school allowed to reach a module that is not generally released yet (pilot or
 * internal testing). Separate from entitlements: a school still needs the module in its plan or an add-on.
 */
export const moduleReleaseAccess = pgTable(
  "module_release_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    module: text("module").notNull(),
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("module_release_access_one_open")
      .on(t.tenantId, t.module)
      .where(sql`${t.endedAt} is null`),
    check("module_release_access_module_valid", sql`${t.module} = any(${PLAN_MODULES_SQL})`),
    check("module_release_access_ended", sql`(${t.endedAt} is null) = (${t.endedByUserId} is null)`),
  ],
);

/**
 * Catalogue prices (SUB-07): what EduBridge usually charges for a plan or an add-on, per billing period and
 * currency, flat or per active student. Configuration, never code; a change archives the old price and adds
 * a new one, so the history is kept. A school's agreed price is stored on its plan or add-on.
 */
export const catalogPrices = pgTable(
  "catalog_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Exactly one of: a plan preset or a module (add-on). */
    presetId: uuid("preset_id").references(() => planPresets.id, { onDelete: "restrict" }),
    module: text("module"),
    billingPeriod: text("billing_period", { enum: BILLING_PERIODS }).notNull(),
    currencyCode: text("currency_code").notNull(),
    pricePesewas: bigint("price_pesewas", { mode: "number" }).notNull(),
    unit: text("unit", { enum: ["flat", "per_student"] }).notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    check("catalog_prices_owner", sql`(${t.presetId} is null) <> (${t.module} is null)`),
    check("catalog_prices_module_valid", sql`${t.module} is null or ${t.module} = any(${PLAN_MODULES_SQL})`),
    check("catalog_prices_price", sql`${t.pricePesewas} between 0 and 1000000000`),
    check("catalog_prices_currency", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    uniqueIndex("catalog_prices_one_preset_price")
      .on(t.presetId, t.billingPeriod, t.currencyCode)
      .where(sql`${t.archivedAt} is null and ${t.presetId} is not null`),
    uniqueIndex("catalog_prices_one_module_price")
      .on(t.module, t.billingPeriod, t.currencyCode)
      .where(sql`${t.archivedAt} is null and ${t.module} is not null`),
  ],
);

/**
 * A family number's WhatsApp choice (WAB-01), for every school that messages it through EduBridge's WhatsApp
 * number. Opting in is the parent's own act in the parent view (signed in with that number); replying STOP
 * on WhatsApp, or turning it off, opts out. Kept, with dates, as the record of consent.
 */
export const whatsappContacts = pgTable(
  "whatsapp_contacts",
  {
    phone: text("phone").primaryKey(),
    optedInAt: timestamp("opted_in_at", { withTimezone: true }),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    /** How the latest choice was made. */
    source: text("source", { enum: ["parent_view", "whatsapp_reply"] }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("whatsapp_contacts_phone", sql`${t.phone} ~ '^[+][1-9][0-9]{7,14}$'`)],
);

/**
 * An announcement to post later (NOT-06): written now, posted by the worker at `send_at` (with its push and
 * any SMS, charged only then). Cancelled rather than deleted; once posted or cancelled it never changes.
 */
export const scheduledAnnouncements = pgTable(
  "scheduled_announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    audience: text("audience", { enum: ["school", "level", "class", "campus"] }).notNull(),
    audienceId: uuid("audience_id"),
    sms: boolean("sms").notNull().default(false),
    sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["pending", "posted", "cancelled"] })
      .notNull()
      .default("pending"),
    announcementId: uuid("announcement_id"),
    /** Why it was posted without SMS, or cancelled by the worker (e.g. the author lost access). */
    note: text("note"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "scheduled_announcements_announcement_fk",
      columns: [t.tenantId, t.announcementId],
      foreignColumns: [announcements.tenantId, announcements.id],
    }),
    index("scheduled_announcements_due_idx").on(t.status, t.sendAt),
    check("scheduled_announcements_title_length", sql`char_length(${t.title}) between 2 and 100`),
    check("scheduled_announcements_body_length", sql`char_length(${t.body}) between 1 and 2000`),
    check("scheduled_announcements_audience_id", sql`(${t.audience} = 'school') = (${t.audienceId} is null)`),
    check(
      "scheduled_announcements_posted",
      sql`(${t.status} = 'posted') = (${t.announcementId} is not null)`,
    ),
  ],
);

/**
 * Online payment of an EduBridge invoice (SUB-04), into EduBridge's own Paystack account (D-R3-5), separate
 * from schools' accounts. One row per attempt; the reference is "EBI.{tenant}.{id}". A success is recorded
 * only from the provider's own verification (never from a browser redirect or the webhook body), with the
 * amount and currency checked against the invoice; then the invoice is marked paid once (database function).
 */
export const subscriptionPayments = pgTable(
  "subscription_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => subscriptionInvoices.id, { onDelete: "restrict" }),
    reference: text("reference").notNull().unique(),
    provider: text("provider", { enum: ["paystack", "mock"] }).notNull(),
    amountPesewas: bigint("amount_pesewas", { mode: "number" }).notNull(),
    currencyCode: text("currency_code").notNull(),
    status: text("status", { enum: ["initiated", "succeeded", "failed"] })
      .notNull()
      .default("initiated"),
    providerReference: text("provider_reference"),
    channel: text("channel"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    initiatedByUserId: uuid("initiated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    index("subscription_payments_invoice_idx").on(t.tenantId, t.invoiceId),
    check("subscription_payments_amount", sql`${t.amountPesewas} between 1 and 1000000000`),
    check("subscription_payments_currency", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("subscription_payments_paid", sql`(${t.status} = 'succeeded') = (${t.paidAt} is not null)`),
  ],
);

// ——— Staff and HR (R4-1, module staff_hr) ———

/** A school's departments (HR-02), archived not deleted. */
export const staffDepartments = pgTable(
  "staff_departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: citext("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("staff_departments_tenant_name_unique").on(t.tenantId, t.name),
    unique("staff_departments_tenant_id_unique").on(t.tenantId, t.id),
    check("staff_departments_name_length", sql`char_length(${t.name}) between 2 and 80`),
  ],
);

/** A school's positions (HR-02), archived not deleted. */
export const staffPositions = pgTable(
  "staff_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: citext("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("staff_positions_tenant_name_unique").on(t.tenantId, t.name),
    unique("staff_positions_tenant_id_unique").on(t.tenantId, t.id),
    check("staff_positions_name_length", sql`char_length(${t.name}) between 2 and 80`),
  ],
);

/**
 * A person who works at the school (HR-01), with or without an EduBridge account. The current employment is
 * held here; every change is also an insert-only row in staff_employment_events.
 */
export const staff = pgTable(
  "staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    staffNumber: citext("staff_number").notNull(),
    /** The member's EduBridge account at this school, when they have one. */
    membershipId: uuid("membership_id"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    otherNames: text("other_names"),
    sex: text("sex", { enum: ["female", "male"] }),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    phone: text("phone"),
    email: citext("email"),
    address: text("address"),
    qualifications: text("qualifications"),
    emergencyName: text("emergency_name"),
    emergencyRelationship: text("emergency_relationship"),
    emergencyPhone: text("emergency_phone"),
    employmentType: text("employment_type", { enum: EMPLOYMENT_TYPES }).notNull(),
    departmentId: uuid("department_id"),
    positionId: uuid("position_id"),
    campusId: uuid("campus_id"),
    startedOn: date("started_on", { mode: "string" }).notNull(),
    status: text("status", { enum: ["active", "left"] })
      .notNull()
      .default("active"),
    leftOn: date("left_on", { mode: "string" }),
    leavingReason: text("leaving_reason"),
    ...timestamps,
  },
  (t) => [
    unique("staff_tenant_number_unique").on(t.tenantId, t.staffNumber),
    unique("staff_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("staff_one_per_membership")
      .on(t.tenantId, t.membershipId)
      .where(sql`${t.membershipId} is not null`),
    index("staff_tenant_name_idx").on(t.tenantId, t.lastName, t.firstName),
    foreignKey({
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.departmentId],
      foreignColumns: [staffDepartments.tenantId, staffDepartments.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.positionId],
      foreignColumns: [staffPositions.tenantId, staffPositions.id],
    }),
    foreignKey({ columns: [t.tenantId, t.campusId], foreignColumns: [campuses.tenantId, campuses.id] }),
    check(
      "staff_names",
      sql`char_length(${t.firstName}) between 1 and 80 and char_length(${t.lastName}) between 1 and 80`,
    ),
    check("staff_phone", sql`${t.phone} is null or ${t.phone} ~ '^[+][1-9][0-9]{7,14}$'`),
    check(
      "staff_emergency_phone",
      sql`${t.emergencyPhone} is null or ${t.emergencyPhone} ~ '^[+][1-9][0-9]{7,14}$'`,
    ),
    check(
      "staff_left",
      sql`(${t.status} = 'active' and ${t.leftOn} is null and ${t.leavingReason} is null) or (${t.status} = 'left' and ${t.leftOn} is not null)`,
    ),
    check(
      "staff_text_lengths",
      sql`coalesce(char_length(${t.address}), 0) <= 300 and coalesce(char_length(${t.qualifications}), 0) <= 500 and coalesce(char_length(${t.leavingReason}), 0) <= 300`,
    ),
  ],
);

/** Every employment change (HR-01c), insert-only: started, changed, left, returned, with its effective date. */
export const staffEmploymentEvents = pgTable(
  "staff_employment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    staffId: uuid("staff_id").notNull(),
    kind: text("kind", { enum: EMPLOYMENT_EVENT_KINDS }).notNull(),
    effectiveOn: date("effective_on", { mode: "string" }).notNull(),
    employmentType: text("employment_type", { enum: EMPLOYMENT_TYPES }).notNull(),
    departmentId: uuid("department_id"),
    positionId: uuid("position_id"),
    campusId: uuid("campus_id"),
    note: text("note"),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("staff_employment_events_staff_idx").on(t.tenantId, t.staffId, t.effectiveOn),
    foreignKey({ columns: [t.tenantId, t.staffId], foreignColumns: [staff.tenantId, staff.id] }),
    check("staff_employment_events_note_length", sql`coalesce(char_length(${t.note}), 0) <= 300`),
  ],
);

/** The school's leave types (HR-03a); days a year null means no limit. Archived, never deleted. */
export const leaveTypes = pgTable(
  "leave_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: citext("name").notNull(),
    daysPerYear: integer("days_per_year"),
    paid: boolean("paid").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("leave_types_tenant_name_unique").on(t.tenantId, t.name),
    unique("leave_types_tenant_id_unique").on(t.tenantId, t.id),
    check("leave_types_name_length", sql`char_length(${t.name}) between 2 and 60`),
    check("leave_types_days", sql`${t.daysPerYear} is null or ${t.daysPerYear} between 0 and 366`),
  ],
);

/**
 * Leave asked for or recorded (HR-03b/c). Decided once (approved or declined), cancelled once; dates and days
 * never change after the request (trigger), so the record of who was away and why is kept.
 */
export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    staffId: uuid("staff_id").notNull(),
    leaveTypeId: uuid("leave_type_id").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    /** Working days when asked (Monday to Friday, less the school's holidays then). */
    days: integer("days").notNull(),
    reason: text("reason"),
    status: text("status", { enum: LEAVE_STATUSES }).notNull().default("pending"),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [
    index("leave_requests_staff_idx").on(t.tenantId, t.staffId, t.startsOn),
    index("leave_requests_status_idx").on(t.tenantId, t.status),
    foreignKey({ columns: [t.tenantId, t.staffId], foreignColumns: [staff.tenantId, staff.id] }),
    foreignKey({
      columns: [t.tenantId, t.leaveTypeId],
      foreignColumns: [leaveTypes.tenantId, leaveTypes.id],
    }),
    check("leave_requests_dates", sql`${t.endsOn} >= ${t.startsOn}`),
    check("leave_requests_days", sql`${t.days} between 1 and 366`),
    check(
      "leave_requests_text_lengths",
      sql`coalesce(char_length(${t.reason}), 0) <= 300 and coalesce(char_length(${t.decisionNote}), 0) <= 300`,
    ),
    check("leave_requests_cancelled", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
  ],
);

/**
 * Staff attendance (HR-04): one mark per person per day. Changes name the version they were made from and
 * apply only if it is still current (compare-and-set), so nobody silently overwrites anyone; every change is
 * audited with before and after.
 */
export const staffAttendance = pgTable(
  "staff_attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    staffId: uuid("staff_id").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    status: text("status", { enum: STAFF_ATTENDANCE_MARKS }).notNull(),
    note: text("note"),
    version: integer("version").notNull().default(1),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("staff_attendance_one_a_day").on(t.tenantId, t.staffId, t.date),
    index("staff_attendance_date_idx").on(t.tenantId, t.date),
    foreignKey({ columns: [t.tenantId, t.staffId], foreignColumns: [staff.tenantId, staff.id] }),
    check("staff_attendance_note_length", sql`coalesce(char_length(${t.note}), 0) <= 200`),
    check("staff_attendance_version", sql`${t.version} >= 1`),
  ],
);

// ——— Payroll records (R4-2, module payroll) ———

/** A school's pay components (PRL-01a): earnings, deductions and employer contributions. Archived, never deleted. */
export const payComponents = pgTable(
  "pay_components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: citext("name").notNull(),
    kind: text("kind", { enum: COMPONENT_KINDS }).notNull(),
    basis: text("basis", { enum: COMPONENT_BASES }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pay_components_tenant_name_unique").on(t.tenantId, t.name),
    unique("pay_components_tenant_id_unique").on(t.tenantId, t.id),
    check("pay_components_name_length", sql`char_length(${t.name}) between 2 and 60`),
    check("pay_components_basis", sql`not (${t.kind} = 'earning' and ${t.basis} = 'percent_gross')`),
  ],
);

/**
 * A person's salary from a month (PRL-01b): basic pay and the components that apply. Insert-only: a change is a
 * new salary from a later month, so every month's pay can be reproduced.
 */
export const staffSalaries = pgTable(
  "staff_salaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    staffId: uuid("staff_id").notNull(),
    /** First month it applies to, "2026-11". */
    effectiveMonth: text("effective_month").notNull(),
    basicMinor: bigint("basic_minor", { mode: "number" }).notNull(),
    currencyCode: text("currency_code").notNull(),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("staff_salaries_tenant_id_unique").on(t.tenantId, t.id),
    index("staff_salaries_staff_idx").on(t.tenantId, t.staffId, t.effectiveMonth),
    foreignKey({ columns: [t.tenantId, t.staffId], foreignColumns: [staff.tenantId, staff.id] }),
    check("staff_salaries_month", sql`${t.effectiveMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("staff_salaries_basic", sql`${t.basicMinor} between 0 and 100000000000`),
    check("staff_salaries_currency", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("staff_salaries_note_length", sql`coalesce(char_length(${t.note}), 0) <= 300`),
  ],
);

/** The components of one salary, with this person's amount (minor units) or percentage (basis points). */
export const staffSalaryComponents = pgTable(
  "staff_salary_components",
  {
    tenantId: uuid("tenant_id").notNull(),
    salaryId: uuid("salary_id").notNull(),
    componentId: uuid("component_id").notNull(),
    value: bigint("value", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.salaryId, t.componentId] }),
    foreignKey({
      columns: [t.tenantId, t.salaryId],
      foreignColumns: [staffSalaries.tenantId, staffSalaries.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.componentId],
      foreignColumns: [payComponents.tenantId, payComponents.id],
    }),
    check("staff_salary_components_value", sql`${t.value} between 0 and 100000000000`),
  ],
);

/**
 * A month's payroll (PRL-02a): a draft that can be recalculated, then approved by the Proprietor and locked, or
 * cancelled while a draft. One live run per school per month. Status changes once (trigger); never deleted.
 */
export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    month: text("month").notNull(),
    status: text("status", { enum: PAYROLL_STATUSES }).notNull().default("draft"),
    currencyCode: text("currency_code").notNull(),
    preparedByUserId: uuid("prepared_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [
    unique("payroll_runs_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("payroll_runs_one_per_month")
      .on(t.tenantId, t.month)
      .where(sql`${t.status} <> 'cancelled'`),
    check("payroll_runs_month", sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("payroll_runs_currency", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check(
      "payroll_runs_states",
      sql`(${t.status} = 'approved') = (${t.approvedAt} is not null) and (${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
  ],
);

/** One person's pay in a run, with a frozen copy of how it was worked out (PRL-02c). Locked once approved. */
export const payrollLines = pgTable(
  "payroll_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    runId: uuid("run_id").notNull(),
    staffId: uuid("staff_id").notNull(),
    staffName: text("staff_name").notNull(),
    staffNumber: text("staff_number").notNull(),
    position: text("position"),
    salaryId: uuid("salary_id").notNull(),
    basicMinor: bigint("basic_minor", { mode: "number" }).notNull(),
    grossMinor: bigint("gross_minor", { mode: "number" }).notNull(),
    deductionsMinor: bigint("deductions_minor", { mode: "number" }).notNull(),
    netMinor: bigint("net_minor", { mode: "number" }).notNull(),
    employerMinor: bigint("employer_minor", { mode: "number" }).notNull(),
    items: jsonb("items").$type<PayItem[]>().notNull(),
  },
  (t) => [
    unique("payroll_lines_run_staff_unique").on(t.runId, t.staffId),
    index("payroll_lines_staff_idx").on(t.tenantId, t.staffId),
    foreignKey({ columns: [t.tenantId, t.runId], foreignColumns: [payrollRuns.tenantId, payrollRuns.id] }),
    foreignKey({ columns: [t.tenantId, t.staffId], foreignColumns: [staff.tenantId, staff.id] }),
    foreignKey({
      columns: [t.tenantId, t.salaryId],
      foreignColumns: [staffSalaries.tenantId, staffSalaries.id],
    }),
    check("payroll_lines_sums", sql`${t.netMinor} = ${t.grossMinor} - ${t.deductionsMinor}`),
  ],
);

/**
 * A correction or one-off amount for a person (PRL-02b), applied in the first run approved for its month or a
 * later one. Applied once and cancelled once (trigger); never deleted or rewritten.
 */
export const payrollAdjustments = pgTable(
  "payroll_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    staffId: uuid("staff_id").notNull(),
    /** The earliest month whose run includes it. */
    month: text("month").notNull(),
    kind: text("kind", { enum: ["earning", "deduction"] }).notNull(),
    description: text("description").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedRunId: uuid("applied_run_id"),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [
    index("payroll_adjustments_staff_idx").on(t.tenantId, t.staffId),
    foreignKey({ columns: [t.tenantId, t.staffId], foreignColumns: [staff.tenantId, staff.id] }),
    foreignKey({
      columns: [t.tenantId, t.appliedRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    check("payroll_adjustments_month", sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("payroll_adjustments_amount", sql`${t.amountMinor} between 1 and 100000000000`),
    check("payroll_adjustments_description", sql`char_length(${t.description}) between 3 and 120`),
    check("payroll_adjustments_once", sql`${t.appliedRunId} is null or ${t.cancelledAt} is null`),
  ],
);

// ——— Safeguarding (R4-3, module safeguarding) ———

/**
 * The school's designated safeguarding leads (SFG-01b), appointed and ended by the Proprietor. Only they can
 * read cases: the database checks this table (app_is_safeguarding_lead), not just the app. Ended once, never
 * deleted.
 */
export const safeguardingLeads = pgTable(
  "safeguarding_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("safeguarding_leads_one_open")
      .on(t.tenantId, t.membershipId)
      .where(sql`${t.endedAt} is null`),
    foreignKey({
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    check("safeguarding_leads_ended", sql`(${t.endedAt} is null) = (${t.endedByUserId} is null)`),
  ],
);

/**
 * A safeguarding concern about a student (SFG-01a). The reporter's account never changes; leads change only the
 * status and the assigned lead, and add entries. Readable only by leads and, for their own report, the reporter.
 */
export const safeguardingCases = pgTable(
  "safeguarding_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    reference: text("reference").notNull(),
    studentId: uuid("student_id").notNull(),
    category: text("category", { enum: CONCERN_CATEGORIES }).notNull(),
    description: text("description").notNull(),
    occurredOn: date("occurred_on", { mode: "string" }),
    location: text("location"),
    immediateAction: text("immediate_action"),
    reportedByUserId: uuid("reported_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status", { enum: CASE_STATUSES }).notNull().default("open"),
    leadMembershipId: uuid("lead_membership_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("safeguarding_cases_tenant_id_unique").on(t.tenantId, t.id),
    unique("safeguarding_cases_tenant_reference_unique").on(t.tenantId, t.reference),
    index("safeguarding_cases_status_idx").on(t.tenantId, t.status),
    foreignKey({ columns: [t.tenantId, t.studentId], foreignColumns: [students.tenantId, students.id] }),
    foreignKey({
      columns: [t.tenantId, t.leadMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    check("safeguarding_cases_description", sql`char_length(${t.description}) between 10 and 4000`),
    check(
      "safeguarding_cases_text_lengths",
      sql`coalesce(char_length(${t.location}), 0) <= 200 and coalesce(char_length(${t.immediateAction}), 0) <= 2000`,
    ),
  ],
);

/** What leads record on a case (SFG-01c). Insert-only; an action is marked done once. */
export const safeguardingEntries = pgTable(
  "safeguarding_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    caseId: uuid("case_id").notNull(),
    kind: text("kind", { enum: ENTRY_KINDS }).notNull(),
    body: text("body").notNull(),
    dueOn: date("due_on", { mode: "string" }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    doneByUserId: uuid("done_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("safeguarding_entries_case_idx").on(t.tenantId, t.caseId, t.createdAt),
    foreignKey({
      columns: [t.tenantId, t.caseId],
      foreignColumns: [safeguardingCases.tenantId, safeguardingCases.id],
    }),
    check("safeguarding_entries_body", sql`char_length(${t.body}) between 1 and 4000`),
    check("safeguarding_entries_done", sql`(${t.doneAt} is null) = (${t.doneByUserId} is null)`),
  ],
);

/** Every time a lead opened a case or downloaded one of its documents (SFG-01d). Insert-only. */
export const safeguardingAccess = pgTable(
  "safeguarding_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    caseId: uuid("case_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: text("action", { enum: ["viewed", "downloaded"] }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("safeguarding_access_case_idx").on(t.tenantId, t.caseId, t.at),
    foreignKey({
      columns: [t.tenantId, t.caseId],
      foreignColumns: [safeguardingCases.tenantId, safeguardingCases.id],
    }),
  ],
);

/** Confidential documents of a case (SFG-01e), kept apart from other school files. Removed, never deleted. */
export const safeguardingDocuments = pgTable(
  "safeguarding_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    caseId: uuid("case_id").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    content: bytea("content").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedByUserId: uuid("removed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("safeguarding_documents_case_idx").on(t.tenantId, t.caseId),
    foreignKey({
      columns: [t.tenantId, t.caseId],
      foreignColumns: [safeguardingCases.tenantId, safeguardingCases.id],
    }),
    check("safeguarding_documents_size", sql`${t.sizeBytes} between 1 and 5242880`),
    check("safeguarding_documents_filename", sql`char_length(${t.filename}) between 1 and 200`),
  ],
);

// ——— Visitors and pickup (R4-4, module visitors_pickup) ———

/**
 * A visitor signed in at the school (VIS-01). Signed out once; nothing else changes and visits are never deleted
 * (database). The time is the server's.
 */
export const visitorVisits = pgTable(
  "visitor_visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    campusId: uuid("campus_id"),
    fullName: text("full_name").notNull(),
    phone: text("phone"),
    organisation: text("organisation"),
    purpose: text("purpose", { enum: VISIT_PURPOSES }).notNull(),
    /** The member of staff visited, or `hostName` when they are not a member (or not named). */
    hostMembershipId: uuid("host_membership_id"),
    hostName: text("host_name"),
    badge: text("badge"),
    note: text("note"),
    signedInAt: timestamp("signed_in_at", { withTimezone: true }).notNull().defaultNow(),
    signedInByUserId: uuid("signed_in_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    signedOutAt: timestamp("signed_out_at", { withTimezone: true }),
    signedOutByUserId: uuid("signed_out_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("visitor_visits_day_idx").on(t.tenantId, t.signedInAt),
    index("visitor_visits_on_site_idx")
      .on(t.tenantId)
      .where(sql`${t.signedOutAt} is null`),
    foreignKey({ columns: [t.tenantId, t.campusId], foreignColumns: [campuses.tenantId, campuses.id] }),
    foreignKey({
      columns: [t.tenantId, t.hostMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    check("visitor_visits_name", sql`char_length(${t.fullName}) between 2 and 120`),
    check("visitor_visits_phone_e164", sql`${t.phone} is null or ${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
    check(
      "visitor_visits_text_lengths",
      sql`coalesce(char_length(${t.organisation}), 0) <= 120 and coalesce(char_length(${t.hostName}), 0) <= 120 and coalesce(char_length(${t.badge}), 0) <= 20 and coalesce(char_length(${t.note}), 0) <= 500`,
    ),
    check("visitor_visits_signed_out", sql`(${t.signedOutAt} is null) = (${t.signedOutByUserId} is null)`),
  ],
);

/**
 * Someone other than a guardian who may collect a child (VIS-02a). Ended once with a reason; never deleted. The
 * child's guardians marked "May collect the child" are read from student_guardians, not copied here.
 */
export const pickupCollectors = pgTable(
  "pickup_collectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    studentId: uuid("student_id").notNull(),
    fullName: text("full_name").notNull(),
    relationship: text("relationship").notNull(),
    phone: text("phone"),
    /** A stored file (purpose collector_photo), shown to staff releasing the child. */
    photoFileId: uuid("photo_file_id"),
    /** The last day they may collect the child (inclusive); null: until ended. */
    validUntil: date("valid_until", { mode: "string" }),
    note: text("note"),
    addedByUserId: uuid("added_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    endReason: text("end_reason"),
  },
  (t) => [
    unique("pickup_collectors_tenant_id_unique").on(t.tenantId, t.id),
    index("pickup_collectors_student_idx").on(t.tenantId, t.studentId),
    foreignKey({ columns: [t.tenantId, t.studentId], foreignColumns: [students.tenantId, students.id] }),
    check("pickup_collectors_name", sql`char_length(${t.fullName}) between 2 and 120`),
    check("pickup_collectors_relationship", sql`char_length(${t.relationship}) between 2 and 60`),
    check("pickup_collectors_phone_e164", sql`${t.phone} is null or ${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
    check(
      "pickup_collectors_text_lengths",
      sql`coalesce(char_length(${t.note}), 0) <= 300 and coalesce(char_length(${t.endReason}), 0) <= 300`,
    ),
    check(
      "pickup_collectors_ended",
      sql`(${t.endedAt} is null) = (${t.endedByUserId} is null) and (${t.endedAt} is null) = (${t.endReason} is null)`,
    ),
  ],
);

/**
 * A child released to someone allowed to collect them, or a refusal (VIS-02b, VIS-02c). `onDate` is the school's
 * local day. The person's name is kept as it was. Cancelled once with a reason; otherwise never changed or
 * deleted (database).
 */
export const pickups = pgTable(
  "pickups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    studentId: uuid("student_id").notNull(),
    onDate: date("on_date", { mode: "string" }).notNull(),
    outcome: text("outcome", { enum: PICKUP_OUTCOMES }).notNull(),
    guardianId: uuid("guardian_id"),
    collectorId: uuid("collector_id"),
    personName: text("person_name").notNull(),
    relationship: text("relationship"),
    /** Why the person was refused (refusals only). */
    reason: text("reason"),
    note: text("note"),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    index("pickups_day_idx").on(t.tenantId, t.onDate),
    index("pickups_student_idx").on(t.tenantId, t.studentId, t.recordedAt),
    foreignKey({ columns: [t.tenantId, t.studentId], foreignColumns: [students.tenantId, students.id] }),
    foreignKey({ columns: [t.tenantId, t.guardianId], foreignColumns: [guardians.tenantId, guardians.id] }),
    foreignKey({
      columns: [t.tenantId, t.collectorId],
      foreignColumns: [pickupCollectors.tenantId, pickupCollectors.id],
    }),
    check(
      "pickups_who",
      sql`(${t.outcome} = 'released' and (${t.guardianId} is null) <> (${t.collectorId} is null) and ${t.reason} is null) or (${t.outcome} = 'refused' and ${t.guardianId} is null and ${t.collectorId} is null and ${t.reason} is not null)`,
    ),
    check("pickups_person", sql`char_length(${t.personName}) between 2 and 120`),
    check(
      "pickups_text_lengths",
      sql`coalesce(char_length(${t.relationship}), 0) <= 60 and coalesce(char_length(${t.reason}), 0) <= 500 and coalesce(char_length(${t.note}), 0) <= 300 and coalesce(char_length(${t.cancelReason}), 0) <= 300`,
    ),
    check(
      "pickups_cancelled",
      sql`(${t.cancelledAt} is null) = (${t.cancelledByUserId} is null) and (${t.cancelledAt} is null) = (${t.cancelReason} is null)`,
    ),
  ],
);

// ——— Transport (R4-5, module transport) ———

/** A school vehicle (TRN-01a). Drivers need no EduBridge account. Archived, never deleted. */
export const transportVehicles = pgTable(
  "transport_vehicles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: citext("name").notNull(),
    registration: text("registration"),
    seats: integer("seats"),
    driverName: text("driver_name"),
    driverPhone: text("driver_phone"),
    attendantName: text("attendant_name"),
    attendantPhone: text("attendant_phone"),
    note: text("note"),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("transport_vehicles_tenant_id_unique").on(t.tenantId, t.id),
    unique("transport_vehicles_tenant_name_unique").on(t.tenantId, t.name),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check("transport_vehicles_name", sql`char_length(${t.name}) between 1 and 60`),
    check("transport_vehicles_seats", sql`${t.seats} is null or ${t.seats} between 1 and 200`),
    check(
      "transport_vehicles_phones",
      sql`(${t.driverPhone} is null or ${t.driverPhone} ~ '^\\+[1-9][0-9]{7,14}$') and (${t.attendantPhone} is null or ${t.attendantPhone} ~ '^\\+[1-9][0-9]{7,14}$')`,
    ),
    check(
      "transport_vehicles_text_lengths",
      sql`coalesce(char_length(${t.registration}), 0) <= 20 and coalesce(char_length(${t.driverName}), 0) <= 120 and coalesce(char_length(${t.attendantName}), 0) <= 120 and coalesce(char_length(${t.note}), 0) <= 300`,
    ),
  ],
);

/**
 * A bus route (TRN-01b) and its fare per term (TRN-02a), in the school's currency's minor units; a stop can
 * override it. Archived, never deleted.
 */
export const transportRoutes = pgTable(
  "transport_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: citext("name").notNull(),
    vehicleId: uuid("vehicle_id"),
    farePesewas: bigint("fare_pesewas", { mode: "number" }),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("transport_routes_tenant_id_unique").on(t.tenantId, t.id),
    unique("transport_routes_tenant_name_unique").on(t.tenantId, t.name),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    foreignKey({
      columns: [t.tenantId, t.vehicleId],
      foreignColumns: [transportVehicles.tenantId, transportVehicles.id],
    }),
    check("transport_routes_name", sql`char_length(${t.name}) between 1 and 60`),
    check(
      "transport_routes_fare",
      sql`${t.farePesewas} is null or ${t.farePesewas} between 0 and 100000000000`,
    ),
  ],
);

/** A stop on a route, in order, with its usual times and an optional fare of its own. */
export const transportStops = pgTable(
  "transport_stops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    routeId: uuid("route_id").notNull(),
    name: text("name").notNull(),
    sequence: integer("sequence").notNull(),
    /** "06:45": when the bus usually passes in the morning, and in the afternoon. */
    morningTime: text("morning_time"),
    afternoonTime: text("afternoon_time"),
    farePesewas: bigint("fare_pesewas", { mode: "number" }),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("transport_stops_route_id_unique").on(t.tenantId, t.routeId, t.id),
    foreignKey({
      columns: [t.tenantId, t.routeId],
      foreignColumns: [transportRoutes.tenantId, transportRoutes.id],
    }),
    check("transport_stops_name", sql`char_length(${t.name}) between 1 and 80`),
    check(
      "transport_stops_times",
      sql`(${t.morningTime} is null or ${t.morningTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') and (${t.afternoonTime} is null or ${t.afternoonTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')`,
    ),
    check(
      "transport_stops_fare",
      sql`${t.farePesewas} is null or ${t.farePesewas} between 0 and 100000000000`,
    ),
  ],
);

/**
 * The route and stop a student rides in a term (TRN-01c). One open assignment per student and term; a change
 * ends it (once) and starts another, so the history is kept. The stop must be on the route (foreign key).
 */
export const transportAssignments = pgTable(
  "transport_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    studentId: uuid("student_id").notNull(),
    termId: uuid("term_id").notNull(),
    routeId: uuid("route_id").notNull(),
    stopId: uuid("stop_id").notNull(),
    direction: text("direction", { enum: RIDE_DIRECTIONS }).notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("transport_assignments_one_open")
      .on(t.tenantId, t.studentId, t.termId)
      .where(sql`${t.endedAt} is null`),
    index("transport_assignments_route_idx").on(t.tenantId, t.termId, t.routeId),
    foreignKey({ columns: [t.tenantId, t.studentId], foreignColumns: [students.tenantId, students.id] }),
    foreignKey({ columns: [t.tenantId, t.termId], foreignColumns: [terms.tenantId, terms.id] }),
    foreignKey({
      columns: [t.tenantId, t.routeId, t.stopId],
      foreignColumns: [transportStops.tenantId, transportStops.routeId, transportStops.id],
    }),
    check("transport_assignments_ended", sql`(${t.endedAt} is null) = (${t.endedByUserId} is null)`),
  ],
);

/** The school's transport choices: which optional fee item is transport, and whether families are told. */
export const transportSettings = pgTable(
  "transport_settings",
  {
    tenantId: uuid("tenant_id").primaryKey(),
    feeItemId: uuid("fee_item_id"),
    /** A push notification to families when their child boards or gets off (TRN-03b). */
    notifyFamilies: boolean("notify_families").notNull().default(true),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    foreignKey({ columns: [t.tenantId, t.feeItemId], foreignColumns: [feeItems.tenantId, feeItems.id] }),
  ],
);

/** One run of a route on a day, in one direction (TRN-03a), with the vehicle used that day. */
export const transportTrips = pgTable(
  "transport_trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    routeId: uuid("route_id").notNull(),
    onDate: date("on_date", { mode: "string" }).notNull(),
    direction: text("direction", { enum: TRIP_DIRECTIONS }).notNull(),
    vehicleId: uuid("vehicle_id"),
    startedByUserId: uuid("started_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("transport_trips_tenant_id_unique").on(t.tenantId, t.id),
    unique("transport_trips_one_per_run").on(t.tenantId, t.routeId, t.onDate, t.direction),
    foreignKey({
      columns: [t.tenantId, t.routeId],
      foreignColumns: [transportRoutes.tenantId, transportRoutes.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.vehicleId],
      foreignColumns: [transportVehicles.tenantId, transportVehicles.id],
    }),
  ],
);

/** A child on a trip: boarded, then got off, each marked once and never changed (database). */
export const transportTripMarks = pgTable(
  "transport_trip_marks",
  {
    tenantId: uuid("tenant_id").notNull(),
    tripId: uuid("trip_id").notNull(),
    studentId: uuid("student_id").notNull(),
    /** The child's stop that day. */
    stopId: uuid("stop_id"),
    boardedAt: timestamp("boarded_at", { withTimezone: true }).notNull().defaultNow(),
    boardedByUserId: uuid("boarded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    leftAt: timestamp("left_at", { withTimezone: true }),
    leftByUserId: uuid("left_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.tripId, t.studentId] }),
    index("transport_trip_marks_student_idx").on(t.tenantId, t.studentId),
    foreignKey({
      columns: [t.tenantId, t.tripId],
      foreignColumns: [transportTrips.tenantId, transportTrips.id],
    }),
    foreignKey({ columns: [t.tenantId, t.studentId], foreignColumns: [students.tenantId, students.id] }),
    check("transport_trip_marks_left", sql`(${t.leftAt} is null) = (${t.leftByUserId} is null)`),
    check("transport_trip_marks_order", sql`${t.leftAt} is null or ${t.leftAt} >= ${t.boardedAt}`),
  ],
);

// ——— Inventory, assets and procurement (R4-6, module inventory_assets) ———

/** A supplier the school buys from (INV-02a). Archived, never deleted. */
export const inventorySuppliers = pgTable(
  "inventory_suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: citext("name").notNull(),
    contactName: text("contact_name"),
    phone: text("phone"),
    email: text("email"),
    note: text("note"),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("inventory_suppliers_tenant_id_unique").on(t.tenantId, t.id),
    unique("inventory_suppliers_tenant_name_unique").on(t.tenantId, t.name),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check("inventory_suppliers_name", sql`char_length(${t.name}) between 1 and 120`),
    check("inventory_suppliers_phone", sql`${t.phone} is null or ${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
    check(
      "inventory_suppliers_text_lengths",
      sql`coalesce(char_length(${t.contactName}), 0) <= 120 and coalesce(char_length(${t.email}), 0) <= 254 and coalesce(char_length(${t.note}), 0) <= 300`,
    ),
  ],
);

/** Something the school keeps in stock (INV-01a). What is on hand is the sum of its movements. */
export const stockItems = pgTable(
  "stock_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: citext("name").notNull(),
    category: text("category"),
    /** What one of it is: a ream, a box, a bag. */
    unit: text("unit").notNull(),
    reorderLevel: integer("reorder_level"),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("stock_items_tenant_id_unique").on(t.tenantId, t.id),
    unique("stock_items_tenant_name_unique").on(t.tenantId, t.name),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check("stock_items_name", sql`char_length(${t.name}) between 1 and 80`),
    check("stock_items_unit", sql`char_length(${t.unit}) between 1 and 30`),
    check("stock_items_category", sql`coalesce(char_length(${t.category}), 0) <= 60`),
    check("stock_items_reorder", sql`${t.reorderLevel} is null or ${t.reorderLevel} between 0 and 1000000`),
  ],
);

/**
 * A change to stock (INV-01a): received (positive), issued (negative, to someone or somewhere) or counted (a
 * correction either way, with a reason). Never changed or deleted.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    itemId: uuid("item_id").notNull(),
    kind: text("kind", { enum: MOVEMENT_KINDS }).notNull(),
    quantity: integer("quantity").notNull(),
    unitCostMinor: bigint("unit_cost_minor", { mode: "number" }),
    supplierId: uuid("supplier_id"),
    purchaseRequestId: uuid("purchase_request_id"),
    issuedTo: text("issued_to"),
    reason: text("reason"),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stock_movements_item_idx").on(t.tenantId, t.itemId, t.recordedAt),
    foreignKey({ columns: [t.tenantId, t.itemId], foreignColumns: [stockItems.tenantId, stockItems.id] }),
    foreignKey({
      columns: [t.tenantId, t.supplierId],
      foreignColumns: [inventorySuppliers.tenantId, inventorySuppliers.id],
    }),
    check(
      "stock_movements_kind",
      sql`(${t.kind} = 'received' and ${t.quantity} > 0) or (${t.kind} = 'issued' and ${t.quantity} < 0 and ${t.issuedTo} is not null) or (${t.kind} = 'counted' and ${t.quantity} <> 0 and ${t.reason} is not null)`,
    ),
    check("stock_movements_quantity", sql`${t.quantity} between -1000000 and 1000000`),
    check(
      "stock_movements_cost",
      sql`${t.unitCostMinor} is null or (${t.kind} = 'received' and ${t.unitCostMinor} between 0 and 100000000000)`,
    ),
    check(
      "stock_movements_text_lengths",
      sql`coalesce(char_length(${t.issuedTo}), 0) <= 120 and coalesce(char_length(${t.reason}), 0) <= 300`,
    ),
  ],
);

/**
 * An asset in the register (INV-01c), tagged from a per-school counter. Its location, custodian and condition are
 * the current state; every change is also an insert-only asset event. Disposed once, then never changed.
 */
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    tag: text("tag").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    serialNumber: text("serial_number"),
    location: text("location"),
    custodianMembershipId: uuid("custodian_membership_id"),
    /** A custodian without an EduBridge account. */
    custodianName: text("custodian_name"),
    condition: text("condition", { enum: ASSET_CONDITIONS }).notNull(),
    acquiredOn: date("acquired_on", { mode: "string" }),
    costMinor: bigint("cost_minor", { mode: "number" }),
    supplierId: uuid("supplier_id"),
    note: text("note"),
    status: text("status", { enum: ["active", "disposed"] })
      .notNull()
      .default("active"),
    disposedAt: timestamp("disposed_at", { withTimezone: true }),
    disposalReason: text("disposal_reason"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    unique("assets_tenant_id_unique").on(t.tenantId, t.id),
    unique("assets_tenant_tag_unique").on(t.tenantId, t.tag),
    foreignKey({
      columns: [t.tenantId, t.custodianMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.supplierId],
      foreignColumns: [inventorySuppliers.tenantId, inventorySuppliers.id],
    }),
    check("assets_name", sql`char_length(${t.name}) between 1 and 120`),
    check("assets_cost", sql`${t.costMinor} is null or ${t.costMinor} between 0 and 100000000000`),
    check(
      "assets_text_lengths",
      sql`coalesce(char_length(${t.category}), 0) <= 60 and coalesce(char_length(${t.serialNumber}), 0) <= 80 and coalesce(char_length(${t.location}), 0) <= 120 and coalesce(char_length(${t.custodianName}), 0) <= 120 and coalesce(char_length(${t.note}), 0) <= 300 and coalesce(char_length(${t.disposalReason}), 0) <= 300`,
    ),
    check(
      "assets_disposed",
      sql`(${t.status} = 'disposed') = (${t.disposedAt} is not null) and (${t.disposedAt} is null) = (${t.disposalReason} is null)`,
    ),
  ],
);

/** An asset's history (INV-01c): added, moved, custodian or condition changed, disposed. Insert-only. */
export const assetEvents = pgTable(
  "asset_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    kind: text("kind", { enum: ASSET_EVENT_KINDS }).notNull(),
    /** What changed, in words: "Room 4 → Staff room". */
    detail: text("detail").notNull(),
    note: text("note"),
    byUserId: uuid("by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("asset_events_asset_idx").on(t.tenantId, t.assetId, t.at),
    foreignKey({ columns: [t.tenantId, t.assetId], foreignColumns: [assets.tenantId, assets.id] }),
    check("asset_events_detail", sql`char_length(${t.detail}) between 1 and 300`),
    check("asset_events_note", sql`coalesce(char_length(${t.note}), 0) <= 300`),
  ],
);

/**
 * A request to buy something (INV-02b). Decided once by the Proprietor, never by the person asking (check); the
 * person asking can cancel while it waits; an approved request is received or cancelled. Lines never change.
 */
export const purchaseRequests = pgTable(
  "purchase_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    reason: text("reason"),
    supplierId: uuid("supplier_id"),
    status: text("status", { enum: PURCHASE_STATUSES }).notNull().default("pending"),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closingNote: text("closing_note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("purchase_requests_tenant_id_unique").on(t.tenantId, t.id),
    unique("purchase_requests_tenant_reference_unique").on(t.tenantId, t.reference),
    index("purchase_requests_status_idx").on(t.tenantId, t.status),
    foreignKey({
      columns: [t.tenantId, t.supplierId],
      foreignColumns: [inventorySuppliers.tenantId, inventorySuppliers.id],
    }),
    check("purchase_requests_title", sql`char_length(${t.title}) between 3 and 120`),
    check(
      "purchase_requests_text_lengths",
      sql`coalesce(char_length(${t.reason}), 0) <= 1000 and coalesce(char_length(${t.decisionNote}), 0) <= 500 and coalesce(char_length(${t.closingNote}), 0) <= 500`,
    ),
    check(
      "purchase_requests_not_own",
      sql`${t.decidedByUserId} is null or ${t.decidedByUserId} <> ${t.requestedByUserId}`,
    ),
    check("purchase_requests_decided", sql`(${t.decidedAt} is null) = (${t.decidedByUserId} is null)`),
    check("purchase_requests_closed", sql`(${t.closedAt} is null) = (${t.closedByUserId} is null)`),
  ],
);

/** What a purchase request asks for (INV-02b); the quantity received is recorded once. */
export const purchaseRequestLines = pgTable(
  "purchase_request_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    requestId: uuid("request_id").notNull(),
    position: integer("position").notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceMinor: bigint("unit_price_minor", { mode: "number" }),
    stockItemId: uuid("stock_item_id"),
    receivedQuantity: integer("received_quantity"),
  },
  (t) => [
    index("purchase_request_lines_request_idx").on(t.tenantId, t.requestId, t.position),
    foreignKey({
      columns: [t.tenantId, t.requestId],
      foreignColumns: [purchaseRequests.tenantId, purchaseRequests.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.stockItemId],
      foreignColumns: [stockItems.tenantId, stockItems.id],
    }),
    check("purchase_request_lines_description", sql`char_length(${t.description}) between 1 and 200`),
    check("purchase_request_lines_quantity", sql`${t.quantity} between 1 and 1000000`),
    check(
      "purchase_request_lines_price",
      sql`${t.unitPriceMinor} is null or ${t.unitPriceMinor} between 0 and 100000000000`,
    ),
    check(
      "purchase_request_lines_received",
      sql`${t.receivedQuantity} is null or ${t.receivedQuantity} between 0 and 1000000`,
    ),
  ],
);

/** Something that needs fixing (INV-02c), reported by any member of staff. Done or cancelled is final. */
export const maintenanceRequests = pgTable(
  "maintenance_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    assetId: uuid("asset_id"),
    priority: text("priority", { enum: MAINTENANCE_PRIORITIES }).notNull(),
    status: text("status", { enum: MAINTENANCE_STATUSES }).notNull().default("open"),
    assignedTo: text("assigned_to"),
    reportedByUserId: uuid("reported_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("maintenance_requests_tenant_id_unique").on(t.tenantId, t.id),
    unique("maintenance_requests_tenant_reference_unique").on(t.tenantId, t.reference),
    index("maintenance_requests_status_idx").on(t.tenantId, t.status),
    foreignKey({ columns: [t.tenantId, t.assetId], foreignColumns: [assets.tenantId, assets.id] }),
    check("maintenance_requests_title", sql`char_length(${t.title}) between 3 and 120`),
    check(
      "maintenance_requests_text_lengths",
      sql`coalesce(char_length(${t.description}), 0) <= 2000 and coalesce(char_length(${t.location}), 0) <= 120 and coalesce(char_length(${t.assignedTo}), 0) <= 120`,
    ),
  ],
);

/** Each change to a maintenance request, with who and when (INV-02c). Insert-only. */
export const maintenanceUpdates = pgTable(
  "maintenance_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    requestId: uuid("request_id").notNull(),
    status: text("status", { enum: MAINTENANCE_STATUSES }),
    assignedTo: text("assigned_to"),
    note: text("note"),
    byUserId: uuid("by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("maintenance_updates_request_idx").on(t.tenantId, t.requestId, t.at),
    foreignKey({
      columns: [t.tenantId, t.requestId],
      foreignColumns: [maintenanceRequests.tenantId, maintenanceRequests.id],
    }),
    check(
      "maintenance_updates_text_lengths",
      sql`coalesce(char_length(${t.note}), 0) <= 1000 and coalesce(char_length(${t.assignedTo}), 0) <= 120`,
    ),
  ],
);

// ——— Library (R4-7, module library) ———

/** A book in the catalogue (LIB-01a). One title per ISBN; archived, never deleted. */
export const libraryTitles = pgTable(
  "library_titles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    title: text("title").notNull(),
    author: text("author"),
    isbn: text("isbn"),
    publisher: text("publisher"),
    publishedYear: integer("published_year"),
    category: text("category"),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("library_titles_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("library_titles_isbn_unique")
      .on(t.tenantId, t.isbn)
      .where(sql`${t.isbn} is not null`),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check("library_titles_title", sql`char_length(${t.title}) between 1 and 200`),
    check("library_titles_isbn", sql`${t.isbn} is null or ${t.isbn} ~ '^([0-9]{9}[0-9X]|[0-9]{13})$'`),
    check("library_titles_year", sql`${t.publishedYear} is null or ${t.publishedYear} between 1450 and 2200`),
    check(
      "library_titles_text_lengths",
      sql`coalesce(char_length(${t.author}), 0) <= 200 and coalesce(char_length(${t.publisher}), 0) <= 120 and coalesce(char_length(${t.category}), 0) <= 60`,
    ),
  ],
);

/** A copy of a title (LIB-01b), numbered from a per-school counter (B0001). Withdrawn once, never deleted. */
export const libraryCopies = pgTable(
  "library_copies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    titleId: uuid("title_id").notNull(),
    number: text("number").notNull(),
    shelf: text("shelf"),
    status: text("status", { enum: ["active", "withdrawn"] })
      .notNull()
      .default("active"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnReason: text("withdrawn_reason"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("library_copies_tenant_id_unique").on(t.tenantId, t.id),
    unique("library_copies_tenant_number_unique").on(t.tenantId, t.number),
    index("library_copies_title_idx").on(t.tenantId, t.titleId),
    foreignKey({
      columns: [t.tenantId, t.titleId],
      foreignColumns: [libraryTitles.tenantId, libraryTitles.id],
    }),
    check("library_copies_shelf", sql`coalesce(char_length(${t.shelf}), 0) <= 60`),
    check(
      "library_copies_withdrawn",
      sql`(${t.status} = 'withdrawn') = (${t.withdrawnAt} is not null) and (${t.withdrawnAt} is null) = (${t.withdrawnReason} is null)`,
    ),
  ],
);

/**
 * A copy lent to a student or a member of staff (LIB-01c): exactly one borrower. One open loan per copy (partial
 * unique index). Returned or lost once; a late student's fine is charged to their fee account (LIB-02).
 */
export const libraryLoans = pgTable(
  "library_loans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    copyId: uuid("copy_id").notNull(),
    studentId: uuid("student_id"),
    membershipId: uuid("membership_id"),
    loanedAt: timestamp("loaned_at", { withTimezone: true }).notNull().defaultNow(),
    loanedByUserId: uuid("loaned_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    renewals: integer("renewals").notNull().default(0),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    returnedByUserId: uuid("returned_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    lostAt: timestamp("lost_at", { withTimezone: true }),
    lostByUserId: uuid("lost_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    /** The fine charged for a late return, and the ledger entry that charged it. */
    fineMinor: bigint("fine_minor", { mode: "number" }),
    ledgerEntryId: uuid("ledger_entry_id"),
  },
  (t) => [
    unique("library_loans_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("library_loans_one_open_per_copy")
      .on(t.tenantId, t.copyId)
      .where(sql`${t.returnedAt} is null and ${t.lostAt} is null`),
    index("library_loans_student_idx").on(t.tenantId, t.studentId),
    index("library_loans_member_idx").on(t.tenantId, t.membershipId),
    foreignKey({
      columns: [t.tenantId, t.copyId],
      foreignColumns: [libraryCopies.tenantId, libraryCopies.id],
    }),
    foreignKey({ columns: [t.tenantId, t.studentId], foreignColumns: [students.tenantId, students.id] }),
    foreignKey({
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.ledgerEntryId],
      foreignColumns: [ledgerEntries.tenantId, ledgerEntries.id],
    }),
    check("library_loans_borrower", sql`(${t.studentId} is null) <> (${t.membershipId} is null)`),
    check("library_loans_returned", sql`(${t.returnedAt} is null) = (${t.returnedByUserId} is null)`),
    check("library_loans_lost", sql`(${t.lostAt} is null) = (${t.lostByUserId} is null)`),
    check("library_loans_closed_once", sql`${t.returnedAt} is null or ${t.lostAt} is null`),
    check(
      "library_loans_fine",
      sql`(${t.fineMinor} is null or ${t.fineMinor} > 0) and (${t.ledgerEntryId} is null or ${t.fineMinor} is not null)`,
    ),
    check("library_loans_renewals", sql`${t.renewals} between 0 and 100`),
  ],
);

/** A borrower waiting for a title (LIB-01e); a returned copy is held for the first in the queue. */
export const libraryReservations = pgTable(
  "library_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    titleId: uuid("title_id").notNull(),
    studentId: uuid("student_id"),
    membershipId: uuid("membership_id"),
    status: text("status", { enum: RESERVATION_STATUSES }).notNull().default("waiting"),
    heldCopyId: uuid("held_copy_id"),
    reservedByUserId: uuid("reserved_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("library_reservations_title_idx").on(t.tenantId, t.titleId, t.status, t.reservedAt),
    uniqueIndex("library_reservations_one_held_copy")
      .on(t.tenantId, t.heldCopyId)
      .where(sql`${t.status} = 'ready'`),
    uniqueIndex("library_reservations_one_student")
      .on(t.tenantId, t.titleId, t.studentId)
      .where(sql`${t.status} in ('waiting', 'ready') and ${t.studentId} is not null`),
    uniqueIndex("library_reservations_one_member")
      .on(t.tenantId, t.titleId, t.membershipId)
      .where(sql`${t.status} in ('waiting', 'ready') and ${t.membershipId} is not null`),
    foreignKey({
      columns: [t.tenantId, t.titleId],
      foreignColumns: [libraryTitles.tenantId, libraryTitles.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.heldCopyId],
      foreignColumns: [libraryCopies.tenantId, libraryCopies.id],
    }),
    foreignKey({ columns: [t.tenantId, t.studentId], foreignColumns: [students.tenantId, students.id] }),
    foreignKey({
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    check("library_reservations_borrower", sql`(${t.studentId} is null) <> (${t.membershipId} is null)`),
    check(
      "library_reservations_ready",
      sql`${t.status} <> 'ready' or (${t.heldCopyId} is not null and ${t.readyAt} is not null)`,
    ),
  ],
);

/** The school's loan rules (LIB-01c) and fines (LIB-02, set by those who manage fees). */
export const librarySettings = pgTable(
  "library_settings",
  {
    tenantId: uuid("tenant_id").primaryKey(),
    loanDays: integer("loan_days").notNull().default(14),
    maxLoans: integer("max_loans").notNull().default(3),
    finesEnabled: boolean("fines_enabled").notNull().default(false),
    finePerDayMinor: bigint("fine_per_day_minor", { mode: "number" }),
    fineCapMinor: bigint("fine_cap_minor", { mode: "number" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check("library_settings_loan_days", sql`${t.loanDays} between 1 and 365`),
    check("library_settings_max_loans", sql`${t.maxLoans} between 1 and 50`),
    check(
      "library_settings_fines",
      sql`(${t.finePerDayMinor} is null or ${t.finePerDayMinor} between 1 and 100000000) and (${t.fineCapMinor} is null or ${t.fineCapMinor} between 1 and 100000000000) and (not ${t.finesEnabled} or ${t.finePerDayMinor} is not null)`,
    ),
  ],
);

// ——— Boarding (R4-8, module boarding) ———

/** A boarding house (BRD-01a): boys, girls or mixed. Archived, never deleted. */
export const boardingHouses = pgTable(
  "boarding_houses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: citext("name").notNull(),
    kind: text("kind", { enum: HOUSE_KINDS }).notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    unique("boarding_houses_tenant_id_unique").on(t.tenantId, t.id),
    unique("boarding_houses_tenant_name_unique").on(t.tenantId, t.name),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check("boarding_houses_name", sql`char_length(${t.name}) between 1 and 60`),
  ],
);

/** A room in a house (BRD-01a). */
export const boardingRooms = pgTable(
  "boarding_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    houseId: uuid("house_id").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("boarding_rooms_tenant_id_unique").on(t.tenantId, t.id),
    unique("boarding_rooms_house_name_unique").on(t.tenantId, t.houseId, t.name),
    foreignKey({
      columns: [t.tenantId, t.houseId],
      foreignColumns: [boardingHouses.tenantId, boardingHouses.id],
    }),
    check("boarding_rooms_name", sql`char_length(${t.name}) between 1 and 60`),
  ],
);

/** A bed in a room (BRD-01a). */
export const boardingBeds = pgTable(
  "boarding_beds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    roomId: uuid("room_id").notNull(),
    label: text("label").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("boarding_beds_tenant_id_unique").on(t.tenantId, t.id),
    unique("boarding_beds_room_label_unique").on(t.tenantId, t.roomId, t.label),
    foreignKey({
      columns: [t.tenantId, t.roomId],
      foreignColumns: [boardingRooms.tenantId, boardingRooms.id],
    }),
    check("boarding_beds_label", sql`char_length(${t.label}) between 1 and 30`),
  ],
);

/** House staff (BRD-01b), appointed and ended once by the office; never deleted. */
export const boardingHouseStaff = pgTable(
  "boarding_house_staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    houseId: uuid("house_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    addedByUserId: uuid("added_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("boarding_house_staff_one_open")
      .on(t.tenantId, t.houseId, t.membershipId)
      .where(sql`${t.endedAt} is null`),
    index("boarding_house_staff_member_idx").on(t.tenantId, t.membershipId),
    foreignKey({
      columns: [t.tenantId, t.houseId],
      foreignColumns: [boardingHouses.tenantId, boardingHouses.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    check("boarding_house_staff_ended", sql`(${t.endedAt} is null) = (${t.endedByUserId} is null)`),
  ],
);

/**
 * A boarder's bed for a term (BRD-01c). One open assignment per student and term, and per bed and term (partial
 * unique indexes). Ended once; never deleted. Term billing charges the boarding item to students with one.
 */
export const boardingAssignments = pgTable(
  "boarding_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    studentId: uuid("student_id").notNull(),
    termId: uuid("term_id").notNull(),
    bedId: uuid("bed_id").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("boarding_assignments_one_bed_per_student")
      .on(t.tenantId, t.studentId, t.termId)
      .where(sql`${t.endedAt} is null`),
    uniqueIndex("boarding_assignments_one_student_per_bed")
      .on(t.tenantId, t.bedId, t.termId)
      .where(sql`${t.endedAt} is null`),
    foreignKey({ columns: [t.tenantId, t.studentId], foreignColumns: [students.tenantId, students.id] }),
    foreignKey({ columns: [t.tenantId, t.termId], foreignColumns: [terms.tenantId, terms.id] }),
    foreignKey({ columns: [t.tenantId, t.bedId], foreignColumns: [boardingBeds.tenantId, boardingBeds.id] }),
    check("boarding_assignments_ended", sql`(${t.endedAt} is null) = (${t.endedByUserId} is null)`),
  ],
);

/** A boarder away on exeat (BRD-03): signed out and back in, each once; one open per boarder; never deleted. */
export const boardingExeats = pgTable(
  "boarding_exeats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    studentId: uuid("student_id").notNull(),
    houseId: uuid("house_id").notNull(),
    reason: text("reason").notNull(),
    collectedBy: text("collected_by").notNull(),
    expectedBackOn: date("expected_back_on", { mode: "string" }).notNull(),
    outAt: timestamp("out_at", { withTimezone: true }).notNull().defaultNow(),
    outByUserId: uuid("out_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    backAt: timestamp("back_at", { withTimezone: true }),
    backByUserId: uuid("back_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("boarding_exeats_one_open")
      .on(t.tenantId, t.studentId)
      .where(sql`${t.backAt} is null`),
    index("boarding_exeats_house_idx").on(t.tenantId, t.houseId, t.outAt),
    foreignKey({ columns: [t.tenantId, t.studentId], foreignColumns: [students.tenantId, students.id] }),
    foreignKey({
      columns: [t.tenantId, t.houseId],
      foreignColumns: [boardingHouses.tenantId, boardingHouses.id],
    }),
    check("boarding_exeats_back", sql`(${t.backAt} is null) = (${t.backByUserId} is null)`),
    check(
      "boarding_exeats_text_lengths",
      sql`char_length(${t.reason}) between 3 and 300 and char_length(${t.collectedBy}) between 2 and 120 and coalesce(char_length(${t.note}), 0) <= 300`,
    ),
  ],
);

/** Which optional fee item is boarding (BRD-02). */
export const boardingSettings = pgTable(
  "boarding_settings",
  {
    tenantId: uuid("tenant_id").primaryKey(),
    feeItemId: uuid("fee_item_id"),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    foreignKey({ columns: [t.tenantId, t.feeItemId], foreignColumns: [feeItems.tenantId, feeItems.id] }),
  ],
);

/**
 * A finance check flag looked at (R5-2, FCT-02b): once per flag, with a note, kept. The key names the flag and the
 * facts it found, so a flag whose facts change is a new flag. Insert-only (enforced in the database).
 */
export const financeCheckReviews = pgTable(
  "finance_check_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    checkKey: text("check_key").notNull(),
    rule: text("rule", { enum: FINANCE_CHECK_RULES }).notNull(),
    note: text("note").notNull(),
    reviewedByUserId: uuid("reviewed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("finance_check_reviews_key").on(t.tenantId, t.checkKey),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check(
      "finance_check_reviews_lengths",
      sql`char_length(${t.checkKey}) between 3 and 300 and char_length(${t.note}) between 3 and 500`,
    ),
  ],
);

/**
 * A school's early-warning rules (R5-3, EWS-01a): one row per school, the suggested defaults (D-R5-8) until the
 * Proprietor or Head teacher changes them.
 */
export const earlyWarningRules = pgTable(
  "early_warning_rules",
  {
    tenantId: uuid("tenant_id").primaryKey(),
    attendanceOn: boolean("attendance_on").notNull().default(true),
    attendancePercent: integer("attendance_percent").notNull().default(85),
    attendanceDays: integer("attendance_days").notNull().default(28),
    absencesOn: boolean("absences_on").notNull().default(true),
    absencesInARow: integer("absences_in_a_row").notNull().default(3),
    averageOn: boolean("average_on").notNull().default(true),
    averageDrop: integer("average_drop").notNull().default(10),
    subjectsOn: boolean("subjects_on").notNull().default(true),
    subjectsCount: integer("subjects_count").notNull().default(2),
    passMark: integer("pass_mark").notNull().default(50),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check(
      "early_warning_rules_ranges",
      sql`${t.attendancePercent} between 50 and 100 and ${t.attendanceDays} between 7 and 90 and ${t.absencesInARow} between 2 and 10 and ${t.averageDrop} between 3 and 50 and ${t.subjectsCount} between 1 and 10 and ${t.passMark} between 20 and 80`,
    ),
  ],
);

/**
 * A support plan for a student (R5-3, EWS-03): what the school will do, who is responsible and when it is reviewed.
 * Never edited: updates are added (support_plan_updates) and it is closed once with an outcome.
 */
export const supportPlans = pgTable(
  "support_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    studentId: uuid("student_id").notNull(),
    goal: text("goal").notNull(),
    actions: text("actions").notNull(),
    responsible: text("responsible").notNull(),
    reviewOn: date("review_on", { mode: "string" }).notNull(),
    openedByUserId: uuid("opened_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    outcome: text("outcome"),
  },
  (t) => [
    unique("support_plans_tenant_id_unique").on(t.tenantId, t.id),
    index("support_plans_student_idx").on(t.tenantId, t.studentId, t.openedAt),
    foreignKey({ columns: [t.tenantId, t.studentId], foreignColumns: [students.tenantId, students.id] }),
    check(
      "support_plans_closed",
      sql`(${t.closedAt} is null) = (${t.closedByUserId} is null) and (${t.closedAt} is null) = (${t.outcome} is null)`,
    ),
    check(
      "support_plans_text_lengths",
      sql`char_length(${t.goal}) between 3 and 300 and char_length(${t.actions}) between 3 and 1000 and char_length(${t.responsible}) between 2 and 120 and coalesce(char_length(${t.outcome}), 3) between 3 and 500`,
    ),
  ],
);

/** A note added to a support plan, with an optional new review date (EWS-03). Insert-only. */
export const supportPlanUpdates = pgTable(
  "support_plan_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    planId: uuid("plan_id").notNull(),
    note: text("note").notNull(),
    reviewOn: date("review_on", { mode: "string" }),
    byUserId: uuid("by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("support_plan_updates_plan_idx").on(t.tenantId, t.planId, t.at),
    foreignKey({ columns: [t.tenantId, t.planId], foreignColumns: [supportPlans.tenantId, supportPlans.id] }),
    check("support_plan_updates_note", sql`char_length(${t.note}) between 3 and 1000`),
  ],
);

/**
 * A teacher's review of an early-warning indicator (R5-3, EWS-02a): once per indicator, with the outcome and a
 * reason, kept. The key names the rule, the student and the stretch it covers. Insert-only.
 */
export const earlyWarningReviews = pgTable(
  "early_warning_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    indicatorKey: text("indicator_key").notNull(),
    studentId: uuid("student_id").notNull(),
    rule: text("rule", { enum: EARLY_WARNING_RULES }).notNull(),
    outcome: text("outcome", { enum: REVIEW_OUTCOMES }).notNull(),
    reason: text("reason").notNull(),
    supportPlanId: uuid("support_plan_id"),
    reviewedByUserId: uuid("reviewed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("early_warning_reviews_key").on(t.tenantId, t.indicatorKey),
    index("early_warning_reviews_student_idx").on(t.tenantId, t.studentId),
    foreignKey({ columns: [t.tenantId, t.studentId], foreignColumns: [students.tenantId, students.id] }),
    foreignKey({
      columns: [t.tenantId, t.supportPlanId],
      foreignColumns: [supportPlans.tenantId, supportPlans.id],
    }),
    check(
      "early_warning_reviews_plan",
      sql`(${t.outcome} = 'support_plan') = (${t.supportPlanId} is not null)`,
    ),
    check(
      "early_warning_reviews_lengths",
      sql`char_length(${t.indicatorKey}) between 3 and 200 and char_length(${t.reason}) between 3 and 500`,
    ),
  ],
);

/** AI feature flags per task (R5-4, AIG-02), set by platform staff. Under the global switch (ai_enabled). */
export const aiFeatureFlags = pgTable("ai_feature_flags", {
  task: text("task").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
});

/**
 * A school's own AI limits (R5-4, AIG-03), set by platform staff (e.g. to match the plan it pays for); null keeps the
 * platform default.
 */
export const aiSchoolLimits = pgTable(
  "ai_school_limits",
  {
    tenantId: uuid("tenant_id").primaryKey(),
    monthlyTokens: integer("monthly_tokens"),
    userPerHour: integer("user_per_hour"),
    userDailyTokens: integer("user_daily_tokens"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] })],
);

/**
 * Every AI call, and every attempt a limit stopped (R5-4, AIG-04): who, which task, provider and model, tokens,
 * estimated cost (millionths of a US dollar; zero for free and local providers), outcome and time. Insert-only.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
    /** One person's request (e.g. a question), which may take several calls: limits per minute and hour count these. */
    requestId: uuid("request_id").notNull(),
    task: text("task").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }),
    outcome: text("outcome", {
      enum: ["ok", "refused", "length", "provider_quota", "unavailable", "failed", "blocked"],
    }).notNull(),
    /** Which limit stopped a blocked attempt, or the provider error kind. */
    detail: text("detail"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_usage_tenant_idx").on(t.tenantId, t.createdAt),
    index("ai_usage_user_idx").on(t.tenantId, t.userId, t.createdAt),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
  ],
);

/** Tokens used across every school, by month (R5-4, AIG-03): totals only, for the platform limit. */
export const aiPlatformMonths = pgTable("ai_platform_months", {
  month: date("month", { mode: "string" }).primaryKey(),
  tokens: bigint("tokens", { mode: "number" }).notNull().default(0),
});

/**
 * A draft written by AI for a person to edit (R5-5, DRF-04): who asked, the task, the provider and model, what was
 * sent (never names), the drafts, and the outcome, decided once: used as drafted, changed, or discarded. Never deleted.
 */
export const aiDrafts = pgTable(
  "ai_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    task: text("task", { enum: ["remarks", "announcements", "board_report"] }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** What the draft was for and the facts sent, with no names (e.g. the subject totals for a remark). */
    sent: jsonb("sent").$type<Record<string, unknown>>().notNull(),
    /** The suggestions, as shown (placeholders filled in on our server). */
    drafts: jsonb("drafts").$type<string[]>().notNull(),
    /** What the draft was about, e.g. the report card student (for remarks); kept out of what was sent. */
    subjectId: uuid("subject_id"),
    outcome: text("outcome", { enum: ["used", "changed", "discarded"] }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_drafts_tenant_idx").on(t.tenantId, t.createdAt),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check("ai_drafts_decided", sql`(${t.outcome} is null) = (${t.decidedAt} is null)`),
  ],
);

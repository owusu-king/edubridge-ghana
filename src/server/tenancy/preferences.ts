import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { TEMPLATE_IDS } from "../../lib/curricula";
import { MAX_ADMISSION_FEES, type AdmissionFee } from "../../lib/admissions";
import { REPORT_CARD_STYLES, type ReportCardStyle } from "../../lib/report-styles";
import { parseMoney } from "../../lib/money";
import { localizePhoneField, normalizeCallablePhone, normalizePhone } from "../../lib/phone";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Queryable } from "../db/client";
import { withTenant } from "../db/context";
import { schoolPreferences } from "../db/schema";
import type { TenantContext } from "./service";

/**
 * A school's own choices (founder decisions, 2026-11-06): whether Accountants may void receipts, decided by
 * the Proprietor; and how the overview's collection rate and attendance follow-up are defined.
 */

export interface SchoolPreferences {
  accountantsCanVoid: boolean;
  collectionRateBasis: "due" | "billed";
  attendanceConcernPercent: number;
  attendanceConcernMinDays: number;
  paymentReceiptSms: boolean;
  autoRemindersEnabled: boolean;
  autoReminderIntervalDays: number;
  autoReminderMinPesewas: number;
  autoRemindersLastRunOn: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  contactWhatsapp: string | null;
  officeHours: string | null;
  assistantEnabled: boolean;
  assistantShareNames: boolean;
  offlineReceiptsEnabled: boolean;
  discountApprovalBasisPoints: number | null;
  discountApprovalPesewas: number | null;
  brandColor: string | null;
  logoFileId: string | null;
  admissionPrefix: string | null;
  admissionDigits: number;
  /** Starter template (src/lib/curricula.ts); null: the country's default. */
  curriculumTemplate: string | null;
  /** "class": class teachers enter every mark; "subject": subject teachers enter their subjects' marks. */
  teachingModel: "class" | "subject";
  /** Report-card layout; null: the one that suits the school's template. */
  reportCardStyle: ReportCardStyle | null;
  /** Whether teachers take a register in each timetabled lesson. */
  lessonAttendance: boolean;
  /** Families may apply online (each phone check costs the school an SMS). */
  onlineApplications: boolean;
  /** Admission fees charged on enrolment (frozen into each offer). */
  admissionFees: AdmissionFee[];
}

export const DEFAULT_PREFERENCES: SchoolPreferences = {
  accountantsCanVoid: false,
  collectionRateBasis: "due",
  attendanceConcernPercent: 80,
  attendanceConcernMinDays: 5,
  paymentReceiptSms: false,
  autoRemindersEnabled: false,
  autoReminderIntervalDays: 14,
  autoReminderMinPesewas: 10_000,
  autoRemindersLastRunOn: null,
  contactPhone: null,
  contactEmail: null,
  contactWhatsapp: null,
  officeHours: null,
  assistantEnabled: false,
  assistantShareNames: false,
  offlineReceiptsEnabled: false,
  discountApprovalBasisPoints: null,
  discountApprovalPesewas: null,
  brandColor: null,
  logoFileId: null,
  admissionPrefix: null,
  admissionDigits: 4,
  curriculumTemplate: null,
  teachingModel: "class",
  reportCardStyle: null,
  lessonAttendance: false,
  onlineApplications: false,
  admissionFees: [],
};

/** The school's preferences, or the defaults (inside a tenant transaction). */
export async function readPreferences(tx: Queryable, tenantId: string): Promise<SchoolPreferences> {
  const [row] = await tx
    .select({
      accountantsCanVoid: schoolPreferences.accountantsCanVoid,
      collectionRateBasis: schoolPreferences.collectionRateBasis,
      attendanceConcernPercent: schoolPreferences.attendanceConcernPercent,
      attendanceConcernMinDays: schoolPreferences.attendanceConcernMinDays,
      paymentReceiptSms: schoolPreferences.paymentReceiptSms,
      autoRemindersEnabled: schoolPreferences.autoRemindersEnabled,
      autoReminderIntervalDays: schoolPreferences.autoReminderIntervalDays,
      autoReminderMinPesewas: schoolPreferences.autoReminderMinPesewas,
      autoRemindersLastRunOn: schoolPreferences.autoRemindersLastRunOn,
      contactPhone: schoolPreferences.contactPhone,
      contactEmail: schoolPreferences.contactEmail,
      contactWhatsapp: schoolPreferences.contactWhatsapp,
      officeHours: schoolPreferences.officeHours,
      assistantEnabled: schoolPreferences.assistantEnabled,
      assistantShareNames: schoolPreferences.assistantShareNames,
      offlineReceiptsEnabled: schoolPreferences.offlineReceiptsEnabled,
      discountApprovalBasisPoints: schoolPreferences.discountApprovalBasisPoints,
      discountApprovalPesewas: schoolPreferences.discountApprovalPesewas,
      brandColor: schoolPreferences.brandColor,
      logoFileId: schoolPreferences.logoFileId,
      admissionPrefix: schoolPreferences.admissionPrefix,
      admissionDigits: schoolPreferences.admissionDigits,
      curriculumTemplate: schoolPreferences.curriculumTemplate,
      teachingModel: schoolPreferences.teachingModel,
      reportCardStyle: schoolPreferences.reportCardStyle,
      lessonAttendance: schoolPreferences.lessonAttendance,
      onlineApplications: schoolPreferences.onlineApplications,
      admissionFees: schoolPreferences.admissionFees,
    })
    .from(schoolPreferences)
    .where(eq(schoolPreferences.tenantId, tenantId));
  return row ?? DEFAULT_PREFERENCES;
}

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export async function getSchoolPreferences(
  database: Database,
  ctx: TenantContext,
): Promise<SchoolPreferences> {
  return withTenant(database, scope(ctx), (tx) => readPreferences(tx, ctx.tenant.id));
}

async function save(
  database: Database,
  ctx: TenantContext,
  changes: Partial<SchoolPreferences>,
  action: string,
): Promise<void> {
  await withTenant(database, scope(ctx), async (tx) => {
    const before = await readPreferences(tx, ctx.tenant.id);
    const values = { ...before, ...changes, updatedAt: new Date(), updatedByUserId: ctx.userId };
    await tx
      .insert(schoolPreferences)
      .values({ tenantId: ctx.tenant.id, ...values })
      .onConflictDoUpdate({ target: schoolPreferences.tenantId, set: values });
    const from = Object.fromEntries(
      Object.keys(changes).map((k) => [k, before[k as keyof SchoolPreferences]]),
    );
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action,
      entityType: "tenant",
      entityId: ctx.tenant.id,
      metadata: { from, to: changes },
    });
  });
}

/** Who may void receipts: the Proprietor only, or also Accountants. The Proprietor decides. */
export async function saveVoidPolicy(database: Database, ctx: TenantContext, input: unknown): Promise<void> {
  assertAllowed(ctx, "security.manage");
  const { accountantsCanVoid } = z.object({ accountantsCanVoid: z.boolean() }).parse(input);
  await save(database, ctx, { accountantsCanVoid }, "school.void_policy_updated");
}

const overviewSchema = z.object({
  collectionRateBasis: z.enum(["due", "billed"], {
    message: "Choose how the collection rate is worked out.",
  }),
  attendanceConcernPercent: z.coerce
    .number()
    .int("Use a whole number.")
    .min(1, "Use 1 to 100.")
    .max(100, "Use 1 to 100."),
  attendanceConcernMinDays: z.coerce
    .number()
    .int("Use a whole number.")
    .min(1, "Use 1 or more.")
    .max(100, "Use 100 or fewer."),
});

export async function saveOverviewPreferences(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "school.settings.manage");
  await save(database, ctx, overviewSchema.parse(input), "school.overview_preferences_updated");
}

const messageSchema = (currency: string) =>
  z.object({
    paymentReceiptSms: z.boolean(),
    autoRemindersEnabled: z.boolean(),
    autoReminderIntervalDays: z.coerce
      .number()
      .int("Use a whole number.")
      .min(7, "Use 7 to 90 days.")
      .max(90, "Use 7 to 90 days."),
    autoReminderMin: z.string().transform((text, issue) => {
      const pesewas = parseMoney(text.trim() === "" ? "0" : text, currency);
      if (pesewas === null) {
        issue.addIssue({ code: "custom", message: "Enter an amount, like 100." });
        return z.NEVER;
      }
      return pesewas;
    }),
  });

/** Payment receipt SMS and automatic fee reminders: the Proprietor and Accountant decide (they cost SMS). */
export async function saveMessageSettings(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "fees.manage");
  const data = messageSchema(ctx.tenant.currencyCode).parse(input);
  await save(
    database,
    ctx,
    {
      paymentReceiptSms: data.paymentReceiptSms,
      autoRemindersEnabled: data.autoRemindersEnabled,
      autoReminderIntervalDays: data.autoReminderIntervalDays,
      autoReminderMinPesewas: data.autoReminderMin,
    },
    "school.message_settings_updated",
  );
}

const optional = (max: number, message: string) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max, message).nullable(),
  );

const contactsSchema = z.object({
  contactPhone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z
      .string()
      .nullable()
      .transform((v, issue) => {
        if (v === null) return null;
        const phone = normalizeCallablePhone(v);
        if (!phone) {
          issue.addIssue({ code: "custom", message: "Enter a valid phone number, e.g. 030 123 4567." });
          return z.NEVER;
        }
        return phone;
      }),
  ),
  contactWhatsapp: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z
      .string()
      .nullable()
      .transform((v, issue) => {
        if (v === null) return null;
        const phone = normalizePhone(v);
        if (!phone) {
          issue.addIssue({ code: "custom", message: "Enter the WhatsApp number, e.g. 024 123 4567." });
          return z.NEVER;
        }
        return phone;
      }),
  ),
  contactEmail: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().toLowerCase().email("Enter a valid email address.").max(254).nullable(),
  ),
  officeHours: optional(120, "Use 120 characters or fewer."),
});

/** How families reach the school, shown in the parent view (PRT-06). */
export async function saveSchoolContacts(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "school.settings.manage");
  const country = ctx.tenant.countryCode;
  const local = localizePhoneField(
    localizePhoneField(input, country, "contactPhone"),
    country,
    "contactWhatsapp",
  );
  await save(database, ctx, contactsSchema.parse(local), "school.contacts_updated");
}

const assistantPrefsSchema = z.object({
  assistantEnabled: z.boolean(),
  assistantShareNames: z.boolean(),
});

/**
 * The Proprietor decides whether staff may use the school assistant, and whether student and staff names
 * may be sent to the provider (otherwise the assistant sees references, and names are put back on screen).
 */
export async function saveAssistantPreferences(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "assistant.manage");
  await save(database, ctx, assistantPrefsSchema.parse(input), "school.assistant_preferences_updated");
}

/** The Proprietor allows (or stops) payments being taken without a connection, with provisional receipts. */
export async function saveOfflineReceiptsPreference(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "security.manage");
  const data = z.object({ offlineReceiptsEnabled: z.boolean() }).parse(input);
  await save(database, ctx, data, "school.offline_receipts_updated");
}

const discountApprovalSchema = (currency: string) =>
  z.object({
    /** Percentage above which a discount needs approval; blank for none. */
    percent: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? null : v),
      z.coerce.number().min(0, "Use 0 to 100.").max(100, "Use 0 to 100.").nullable(),
    ),
    /** Fixed amount above which a discount needs approval; blank for none. */
    amount: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? null : v),
      z
        .string()
        .nullable()
        .transform((text, issue) => {
          if (text === null) return null;
          const minor = parseMoney(text, currency);
          if (minor === null) {
            issue.addIssue({ code: "custom", message: "Enter an amount, like 500." });
            return z.NEVER;
          }
          return minor;
        }),
    ),
  });

/** The Proprietor sets when discounts need their approval (FIN-05); blank thresholds mean never. */
export async function saveDiscountApprovalPolicy(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "fees.approve_discounts");
  const data = discountApprovalSchema(ctx.tenant.currencyCode).parse(input);
  await save(
    database,
    ctx,
    {
      discountApprovalBasisPoints: data.percent === null ? null : Math.round(data.percent * 100),
      discountApprovalPesewas: data.amount,
    },
    "school.discount_approval_updated",
  );
}

/** SIS-01: admission numbers as the school writes them: an optional prefix and a number of digits. */
export async function saveAdmissionFormat(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "school.settings.manage");
  const data = z
    .object({
      admissionPrefix: z.preprocess(
        (v) => (typeof v === "string" && v.trim() === "" ? null : v),
        z
          .string()
          .trim()
          .max(10, "Use 10 characters or fewer.")
          .regex(/^[A-Za-z0-9/\-]+$/, "Use letters, numbers, / or -.")
          .nullable(),
      ),
      admissionDigits: z.coerce.number().int().min(3, "Use 3 to 8 digits.").max(8, "Use 3 to 8 digits."),
    })
    .parse(input);
  await save(database, ctx, data, "school.admission_format_updated");
}

/** Which starter template the school uses for levels, subjects and grading defaults. */
export async function saveCurriculumTemplate(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  const { curriculumTemplate } = z
    .object({ curriculumTemplate: z.enum(TEMPLATE_IDS, { message: "Choose a template." }) })
    .parse(input);
  await save(database, ctx, { curriculumTemplate }, "school.curriculum_template_changed");
}

/** How teachers are assigned: class teachers for everything, or subject teachers per class (see the schema). */
export async function saveTeachingModel(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  const { teachingModel } = z
    .object({ teachingModel: z.enum(["class", "subject"], { message: "Choose how teachers are assigned." }) })
    .parse(input);
  await save(database, ctx, { teachingModel }, "school.teaching_model_changed");
}

/** Which report-card layout the school prints (or null, to follow its template). */
export async function saveReportCardStyle(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  const { reportCardStyle } = z
    .object({
      reportCardStyle: z
        .string()
        .transform((v) => (v === "template" || v === "" ? null : v))
        .pipe(z.enum(REPORT_CARD_STYLES, { message: "Choose a layout." }).nullable()),
    })
    .parse(input);
  await save(database, ctx, { reportCardStyle }, "school.report_card_style_changed");
}

/** Whether teachers take a register in every timetabled lesson, as well as the daily class register. */
export async function saveLessonAttendance(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "attendance.manage");
  const { lessonAttendance } = z
    .object({ lessonAttendance: z.enum(["on", "off"]).transform((v) => v === "on") })
    .parse(input);
  await save(database, ctx, { lessonAttendance }, "school.lesson_attendance_changed");
}

/** Whether families may apply online (ADM-02). Each application's phone check costs the school an SMS. */
export async function saveOnlineApplications(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "admissions.manage");
  const { onlineApplications } = z
    .object({ onlineApplications: z.enum(["on", "off"]).transform((v) => v === "on") })
    .parse(input);
  await save(database, ctx, { onlineApplications }, "school.online_applications_changed");
}

/**
 * The admission fees charged when an applicant is enrolled (D-R3-1), set by finance staff. Each offer
 * keeps the fees as they were when it was made, so changing them later never changes an offer already sent.
 */
export async function saveAdmissionFees(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "fees.manage");
  const currency = ctx.tenant.currencyCode;
  const { fees } = z
    .object({
      fees: z
        .array(
          z.object({
            description: z
              .string()
              .trim()
              .min(3, "Say what each fee is for.")
              .max(80, "Use 80 characters or fewer."),
            amount: z.string().transform((text, c) => {
              const minor = parseMoney(text, currency);
              if (minor === null || minor <= 0) {
                c.addIssue({ code: "custom", message: "Enter an amount, like 250 or 250.00." });
                return z.NEVER;
              }
              return minor;
            }),
          }),
        )
        .max(MAX_ADMISSION_FEES, `Use ${MAX_ADMISSION_FEES} fees or fewer.`),
    })
    .parse(input);
  await save(
    database,
    ctx,
    { admissionFees: fees.map((f) => ({ description: f.description, amountPesewas: f.amount })) },
    "school.admission_fees_changed",
  );
}

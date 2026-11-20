import "server-only";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { normalizePhone } from "@/lib/phone";
import { ENQUIRY_ROLES, ENQUIRY_SIZES } from "@/lib/enquiries";
import type { Database } from "../db/client";
import { salesEnquiries, users } from "../db/schema";
import { DomainError } from "../errors";

/**
 * "Book a visit" on the public landing page (2026-11-19): a school asking EduBridge to come and show the product.
 * Anyone can send one, so every field is checked here and again by the database, and one connection can send only
 * a few an hour. Only platform administrators read them (Admin, Enquiries).
 */

export const ENQUIRIES_PER_HOUR = 5;

const trimmed = (max: number, message: string) => z.string().trim().min(1, message).max(max, message);

export const enquirySchema = z.object({
  name: trimmed(120, "Enter your name."),
  role: z.enum(ENQUIRY_ROLES.map(([v]) => v) as [string, ...string[]], { message: "Choose your role." }),
  schoolName: trimmed(160, "Enter your school's name."),
  town: trimmed(120, "Enter the town or area."),
  phone: z
    .string()
    .transform((v) => normalizePhone(v, "GH"))
    .refine((v): v is string => v !== null, "Enter a mobile number, like 024 123 4567."),
  email: z
    .string()
    .trim()
    .max(254)
    .transform((v) => v || null)
    .refine(
      (v) => v === null || z.email().safeParse(v).success,
      "Enter a valid email address, or leave it empty.",
    ),
  students: z.enum(ENQUIRY_SIZES.map(([v]) => v) as [string, ...string[]], {
    message: "Choose the number of students.",
  }),
  message: z
    .string()
    .trim()
    .max(1000, "Keep the message under 1,000 characters.")
    .transform((v) => v || null),
});

export type EnquiryInput = z.input<typeof enquirySchema>;

export async function submitEnquiry(
  database: Database,
  input: EnquiryInput,
  client: { ipAddress: string | null },
  now = new Date(),
): Promise<void> {
  const data = enquirySchema.parse(input);
  if (client.ipAddress) {
    const [recent] = await database
      .select({ n: sql<number>`count(*)::int` })
      .from(salesEnquiries)
      .where(
        and(
          eq(salesEnquiries.ipAddress, client.ipAddress),
          gt(salesEnquiries.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
        ),
      );
    if ((recent?.n ?? 0) >= ENQUIRIES_PER_HOUR)
      throw new DomainError(
        "enquiry_busy",
        "We have several requests from this connection already. Try again in an hour, or call us.",
      );
  }
  await database.insert(salesEnquiries).values({
    name: data.name,
    role: data.role as (typeof ENQUIRY_ROLES)[number][0],
    schoolName: data.schoolName,
    town: data.town,
    phone: data.phone,
    email: data.email,
    students: data.students as (typeof ENQUIRY_SIZES)[number][0],
    message: data.message,
    ipAddress: client.ipAddress,
    createdAt: now,
  });
}

export interface EnquiryRow {
  id: string;
  name: string;
  role: string;
  schoolName: string;
  town: string;
  phone: string;
  email: string | null;
  students: string;
  message: string | null;
  createdAt: Date;
  handledAt: Date | null;
  handledBy: string | null;
}

/** Newest first; waiting ones before handled ones. Callers check the platform administrator. */
export async function listEnquiries(database: Database, limit = 200): Promise<EnquiryRow[]> {
  return database
    .select({
      id: salesEnquiries.id,
      name: salesEnquiries.name,
      role: salesEnquiries.role,
      schoolName: salesEnquiries.schoolName,
      town: salesEnquiries.town,
      phone: salesEnquiries.phone,
      email: salesEnquiries.email,
      students: salesEnquiries.students,
      message: salesEnquiries.message,
      createdAt: salesEnquiries.createdAt,
      handledAt: salesEnquiries.handledAt,
      handledBy: users.name,
    })
    .from(salesEnquiries)
    .leftJoin(users, eq(users.id, salesEnquiries.handledByUserId))
    .orderBy(sql`${salesEnquiries.handledAt} is not null`, desc(salesEnquiries.createdAt))
    .limit(limit);
}

export async function countWaitingEnquiries(database: Database): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(salesEnquiries)
    .where(isNull(salesEnquiries.handledAt));
  return row?.n ?? 0;
}

/** Marks an enquiry handled (once). Callers check the platform administrator. */
export async function markEnquiryHandled(
  database: Database,
  adminUserId: string,
  id: string,
  now = new Date(),
): Promise<void> {
  if (!z.uuid().safeParse(id).success) throw new DomainError("not_found", "That enquiry no longer exists.");
  const updated = await database
    .update(salesEnquiries)
    .set({ handledAt: now, handledByUserId: adminUserId })
    .where(and(eq(salesEnquiries.id, id), isNull(salesEnquiries.handledAt)))
    .returning({ id: salesEnquiries.id });
  if (updated.length === 0)
    throw new DomainError("enquiry_handled", "This enquiry is already marked as handled.");
}

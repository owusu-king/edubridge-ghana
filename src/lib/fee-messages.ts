import { formatCalendarDate } from "./format";
import { formatCedis } from "./money";

/**
 * Messages staff share with families from their own WhatsApp (EduBridge sends nothing). Staff see the
 * text in WhatsApp and can edit it before sending. Shared by server and client.
 */

function balanceWords(pesewas: number): string {
  if (pesewas > 0) return `${formatCedis(pesewas)} owed`;
  if (pesewas < 0) return `${formatCedis(-pesewas)} in credit`;
  return "nothing owed";
}

export function feeReminderMessage(input: {
  schoolName: string;
  studentName: string;
  balancePesewas: number;
}): string {
  return (
    `Hello, this is ${input.schoolName}. ${input.studentName}'s school fees balance is ` +
    `${formatCedis(input.balancePesewas)}. Please pay at the school office or by Mobile Money. Thank you.`
  );
}

export function receiptMessage(input: {
  schoolName: string;
  receiptNumber: string;
  amountPesewas: number;
  studentName: string;
  paidOn: string;
  balanceAfterPesewas: number;
}): string {
  return (
    `${input.schoolName}: receipt ${input.receiptNumber}. ${formatCedis(input.amountPesewas)} received for ` +
    `${input.studentName} on ${formatCalendarDate(input.paidOn)}. Balance: ${balanceWords(input.balanceAfterPesewas)}. Thank you.`
  );
}

/**
 * "GHS 1,120.00" for SMS. The cedi sign is outside the GSM alphabet: one "₵" turns the whole SMS into a
 * Unicode one of 70 characters instead of 160, doubling or tripling what the school pays.
 */
export function formatCedisSms(pesewas: number): string {
  return formatCedis(pesewas).replace("GH₵", "GHS ");
}

/** Longer school names are shortened so a reminder stays one SMS for most schools. */
const SMS_SCHOOL_NAME_MAX = 50;

/**
 * The SMS fee reminder: the school, the child's first name and the balance (the founder's decision on
 * 2026-11-04: amounts are common in Ghanaian school SMS and save a trip to the office), and a private link
 * to the balance when there is one. Plain GSM characters only. Without a positive balance it falls back to
 * a reminder with no amount.
 */
export function feeReminderSms(input: {
  schoolName: string;
  studentFirstName: string;
  balancePesewas?: number;
  link?: string;
}): string {
  const school =
    input.schoolName.length > SMS_SCHOOL_NAME_MAX
      ? `${input.schoolName.slice(0, SMS_SCHOOL_NAME_MAX - 1)}.`
      : input.schoolName;
  const balance = input.balancePesewas;
  const owed =
    typeof balance === "number" && Number.isSafeInteger(balance) && balance > 0
      ? `${input.studentFirstName}'s school fees balance is ${formatCedisSms(balance)}.`
      : `a reminder that ${input.studentFirstName}'s school fees are outstanding.`;
  const next = input.link
    ? `See details: ${input.link}`
    : "Please pay at the school office or by Mobile Money. Thank you.";
  return `${school}: ${owed} ${next}`;
}

/**
 * The SMS to a family about absences: how many school days, never the reasons (COM-05). Plain GSM
 * characters, one SMS for typical school names.
 */
export function absenceAlertSms(input: {
  schoolName: string;
  studentFirstName: string;
  days: number;
  kind: "consecutive" | "term_total";
}): string {
  const school =
    input.schoolName.length > SMS_SCHOOL_NAME_MAX
      ? `${input.schoolName.slice(0, SMS_SCHOOL_NAME_MAX - 1)}.`
      : input.schoolName;
  const days = `${input.days} school ${input.days === 1 ? "day" : "days"}`;
  const what =
    input.kind === "consecutive"
      ? `${input.studentFirstName} has been absent for ${days} in a row.`
      : `${input.studentFirstName} has been absent for ${days} this term.`;
  return `${school}: ${what} Please contact the school.`;
}

/** The SMS confirming a payment: amount, receipt number and the balance after it. Plain GSM characters. */
export function paymentReceiptSms(input: {
  schoolName: string;
  studentFirstName: string;
  amountPesewas: number;
  receiptNumber: string;
  balancePesewas: number;
}): string {
  const school =
    input.schoolName.length > SMS_SCHOOL_NAME_MAX
      ? `${input.schoolName.slice(0, SMS_SCHOOL_NAME_MAX - 1)}.`
      : input.schoolName;
  const after =
    input.balancePesewas > 0
      ? `Balance now ${formatCedisSms(input.balancePesewas)}.`
      : input.balancePesewas < 0
        ? `${formatCedisSms(-input.balancePesewas)} in credit.`
        : "Fees fully paid.";
  return `${school}: ${formatCedisSms(input.amountPesewas)} received for ${input.studentFirstName}, receipt ${input.receiptNumber}. ${after} Thank you.`;
}

/** A school announcement by SMS: its title and where to read it in full. */
export function announcementSms(input: { schoolName: string; title: string; link: string }): string {
  const school =
    input.schoolName.length > SMS_SCHOOL_NAME_MAX
      ? `${input.schoolName.slice(0, SMS_SCHOOL_NAME_MAX - 1)}.`
      : input.schoolName;
  return `${school}: ${input.title.slice(0, 90)}. Read it here: ${input.link}`;
}

/** Opens WhatsApp (app or web) with a message ready to send to this number (E.164). */
export function whatsappLink(phoneE164: string, text: string): string {
  return `https://wa.me/${phoneE164.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

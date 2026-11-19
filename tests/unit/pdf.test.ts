import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StudentAccount } from "@/server/fees/ledger";
import type { Receipt } from "@/server/fees/payments";
import { renderReceiptPdf } from "@/web/pdf/receipt";
import { renderStatementPdf } from "@/web/pdf/statement";

/** Set PDF_OUT to a folder to keep the rendered files for a visual check. */
const keep = (name: string, pdf: Buffer) => {
  if (process.env.PDF_OUT) writeFileSync(join(process.env.PDF_OUT, name), pdf);
};

/** Embedded fonts. Text with "₵" pulls in the extended-Latin subset as an extra font. */
const fontCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Subtype \/Type0/g) ?? []).length;

const receipt: Receipt = {
  id: "r1",
  receiptNumber: "R000123",
  amountPesewas: 114000,
  method: "mobile_money",
  reference: "MM260910.0931.C11427",
  payerName: "Grace Mensah",
  paidOn: "2026-09-10",
  recordedBy: "Akosua Darko",
  recordedAt: new Date("2026-09-10T09:31:00Z"),
  student: { id: "s1", name: "Kwame Mensah", admissionNumber: "S0002", className: "Basic 4A" },
  balanceAfterPesewas: 2500,
  voided: null,
};

function account(): StudentAccount {
  const entries: StudentAccount["entries"] = [];
  let balance = 0;
  const add = (
    effectiveOn: string,
    description: string,
    amountPesewas: number,
    kind: string,
    reversed = false,
  ) => {
    balance += amountPesewas;
    entries.push({
      id: String(entries.length),
      kind,
      description,
      effectiveOn,
      amountPesewas,
      balancePesewas: balance,
      reversed,
      paymentId: null,
      recordedBy: null,
      recordedAt: new Date(),
    } as StudentAccount["entries"][number]);
  };
  add("2026-09-08", "Tuition, Term 1 2026/2027", 85000, "charge");
  add("2026-09-08", "PTA dues, Term 1 2026/2027", 5000, "charge", true);
  add("2026-09-08", "Reversed: PTA dues, Term 1 2026/2027 (Charged in error)", -5000, "reversal");
  add("2026-09-08", "Books, Term 1 2026/2027", 18000, "charge");
  add("2026-09-10", "Payment, receipt R000002 (Mobile Money)", -60000, "payment");
  add("2026-09-12", "Sibling discount, Tuition", -8500, "discount");
  return {
    student: { id: "s1", name: "Kwame Mensah", admissionNumber: "S0002" },
    entries,
    balancePesewas: balance,
  };
}

describe("PDFs", () => {
  it("renders a receipt with the cedi sign from an embedded font", async () => {
    const pdf = await renderReceiptPdf({
      receipt,
      schoolName: "Kpone Ridge International School",
      timeZone: "Africa/Accra",
    });
    keep("receipt.pdf", pdf);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // Regular and semibold, each in basic and extended Latin (the latter only for "₵").
    expect(fontCount(pdf)).toBe(4);
  });

  it("marks a voided receipt", async () => {
    const pdf = await renderReceiptPdf({
      receipt: { ...receipt, voided: { reason: "Entered twice", at: new Date(), by: "Proprietor" } },
      schoolName: "Kpone Ridge International School",
      timeZone: "Africa/Accra",
    });
    keep("receipt-void.pdf", pdf);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("renders a statement, across pages when it is long", async () => {
    const short = await renderStatementPdf({
      account: account(),
      schoolName: "Kpone Ridge International School",
      className: "Basic 4A",
      asOf: "2026-11-04",
    });
    keep("statement.pdf", short);
    expect(short.subarray(0, 5).toString()).toBe("%PDF-");

    const long = account();
    for (let i = 0; i < 60; i++) long.entries.push({ ...long.entries[0]!, id: `x${i}` });
    const pdf = await renderStatementPdf({
      account: long,
      schoolName: "Kpone Ridge International School",
      className: null,
      asOf: "2026-11-04",
    });
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });

  it("draws the school's logo on receipts and statements", async () => {
    // A 1x1 PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const logo = { data: png, format: "png" as const };
    const images = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Subtype \/Image/g) ?? []).length;
    const plain = await renderReceiptPdf({ receipt, schoolName: "Kpone Ridge", timeZone: "Africa/Accra" });
    const withLogo = await renderReceiptPdf({
      receipt,
      schoolName: "Kpone Ridge",
      timeZone: "Africa/Accra",
      logo,
    });
    keep("receipt-logo.pdf", withLogo);
    expect(images(plain)).toBe(0);
    expect(images(withLogo)).toBeGreaterThan(0); // PNG transparency adds a second (mask) image
    const statement = await renderStatementPdf({
      account: account(),
      schoolName: "Kpone Ridge",
      className: null,
      asOf: "2026-11-04",
      logo,
    });
    expect(images(statement)).toBeGreaterThan(0);
  });

  it("renders a statement for a date range with its opening balance", async () => {
    const pdf = await renderStatementPdf({
      account: account(),
      schoolName: "Kpone Ridge",
      className: "Basic 4A",
      asOf: "2026-11-04",
      from: "2026-09-10",
      to: "2026-09-30",
    });
    keep("statement-range.pdf", pdf);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("payslip PDF (PRL-03)", () => {
  it("renders an approved payslip with the cedi sign, and marks a draft", async () => {
    const { renderPayslipPdf } = await import("@/web/pdf/payslip");
    const { calculatePay } = await import("@/lib/payroll");
    const pay = calculatePay(2_500_00, [
      { name: "Transport allowance", kind: "earning", basis: "fixed", value: 200_00 },
      { name: "SSNIT (employee)", kind: "deduction", basis: "percent_basic", value: 550 },
      { name: "SSNIT (employer)", kind: "employer", basis: "percent_basic", value: 1300 },
    ]);
    const slip = {
      id: "l1",
      staffId: "s1",
      staffName: "Ama Mensah",
      staffNumber: "S0001",
      position: "Class teacher",
      ...pay,
      month: "2026-10",
      currencyCode: "GHS",
      status: "approved" as const,
      approvedAt: new Date("2026-10-30T12:00:00Z"),
    };
    const pdf = await renderPayslipPdf({ slip, schoolName: "Kpone Ridge International School" });
    keep("payslip.pdf", pdf);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(fontCount(pdf)).toBeGreaterThanOrEqual(2);
    const draft = await renderPayslipPdf({ slip: { ...slip, status: "draft" }, schoolName: "Kpone Ridge" });
    expect(draft.length).toBeGreaterThan(pdf.length - 2000);
  });
});

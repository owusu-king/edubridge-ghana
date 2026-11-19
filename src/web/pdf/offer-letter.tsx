import "server-only";
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { AdmissionFee } from "@/lib/admissions";
import { formatCalendarDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { DocumentLogo } from "@/server/tenancy/branding";
import { SchoolHeading } from "./school-heading";
import { base, COLORS, registerFonts } from "./theme";

/** An offer of a place (ADM-05), printed or shared with the family. Plain, one A4 page. */
const s = StyleSheet.create({
  page: { paddingTop: 48, paddingBottom: 56, paddingHorizontal: 56, fontSize: 10.5, lineHeight: 1.45 },
  header: { borderBottomWidth: 1, borderBottomColor: COLORS.line, paddingBottom: 14, marginBottom: 22 },
  meta: { color: COLORS.ink2, marginBottom: 18 },
  title: { fontSize: 15, fontWeight: 600, marginBottom: 14 },
  paragraph: { marginBottom: 10 },
  table: { marginTop: 6, marginBottom: 14, borderTopWidth: 1, borderTopColor: COLORS.line },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
  },
  total: { fontWeight: 600 },
  signature: { marginTop: 36 },
  line: { width: 180, borderBottomWidth: 1, borderBottomColor: COLORS.ink3, marginTop: 34, marginBottom: 4 },
});

export interface OfferLetter {
  schoolName: string;
  reference: string;
  issuedOn: string;
  guardianName: string;
  childName: string;
  levelName: string;
  className: string | null;
  termName: string;
  termStartsOn: string;
  respondBy: string | null;
  fees: AdmissionFee[];
  currency: string;
  signedBy: string;
}

function Letter({ letter, logo }: { letter: OfferLetter; logo: DocumentLogo | null }) {
  const total = letter.fees.reduce((sum, f) => sum + f.amountPesewas, 0);
  const money = (minor: number) => formatMoney(minor, letter.currency);
  return (
    <Page size="A4" style={[base.page, s.page]}>
      <View style={s.header}>
        <SchoolHeading name={letter.schoolName} logo={logo} />
      </View>
      <Text style={s.meta}>
        {formatCalendarDate(letter.issuedOn)} · Reference {letter.reference}
      </Text>
      <Text style={s.paragraph}>Dear {letter.guardianName},</Text>
      <Text style={s.title}>Offer of a place for {letter.childName}</Text>
      <Text style={s.paragraph}>
        We are pleased to offer {letter.childName} a place in {letter.className ?? letter.levelName} at{" "}
        {letter.schoolName}, starting in {letter.termName}, which begins on{" "}
        {formatCalendarDate(letter.termStartsOn)}.
      </Text>
      {letter.fees.length > 0 ? (
        <>
          <Text style={s.paragraph}>On accepting the place, the following admission fees are charged:</Text>
          <View style={s.table}>
            {letter.fees.map((f, i) => (
              <View key={i} style={s.row}>
                <Text>{f.description}</Text>
                <Text>{money(f.amountPesewas)}</Text>
              </View>
            ))}
            {letter.fees.length > 1 ? (
              <View style={s.row}>
                <Text style={s.total}>Total</Text>
                <Text style={s.total}>{money(total)}</Text>
              </View>
            ) : null}
          </View>
          <Text style={s.paragraph}>Term fees are billed separately, as for every student.</Text>
        </>
      ) : null}
      <Text style={s.paragraph}>
        {letter.respondBy
          ? `Please let us know whether you accept this offer by ${formatCalendarDate(letter.respondBy)}.`
          : "Please let us know whether you accept this offer."}
      </Text>
      <View style={s.signature}>
        <Text>Yours sincerely,</Text>
        <View style={s.line} />
        <Text>{letter.signedBy}</Text>
        <Text style={{ color: COLORS.ink2 }}>{letter.schoolName}</Text>
      </View>
      <View style={base.footer} fixed>
        <Text>
          {letter.schoolName} · Offer {letter.reference}
        </Text>
        <Text>Prepared with EduBridge</Text>
      </View>
    </Page>
  );
}

export async function renderOfferLetterPdf(letter: OfferLetter, logo: DocumentLogo | null): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(
    <Document title={`Offer of a place, ${letter.childName}`} author={letter.schoolName} creator="EduBridge">
      <Letter letter={letter} logo={logo} />
    </Document>,
  );
}

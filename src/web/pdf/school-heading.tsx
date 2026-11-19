import "server-only";
import { Image, Text, View } from "@react-pdf/renderer";
import type { DocumentLogo } from "@/server/tenancy/branding";
import { base } from "./theme";

/** The school's name, with its logo when it has one (TEN-04), at the top of receipts and statements. */
export function SchoolHeading({ name, logo }: { name: string; logo?: DocumentLogo | null }) {
  if (!logo) return <Text style={base.school}>{name}</Text>;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf images take no alt text */}
      <Image
        src={{ data: logo.data, format: logo.format }}
        style={{ width: 32, height: 32, objectFit: "contain" }}
      />
      <Text style={base.school}>{name}</Text>
    </View>
  );
}

import "server-only";
import { join } from "node:path";
import { Font, StyleSheet } from "@react-pdf/renderer";

/**
 * Fonts and styles shared by EduBridge PDFs. IBM Plex Sans matches the app. Its files come in subsets:
 * basic Latin has no cedi sign (₵), so every text style lists the extended Latin subset as a fallback
 * (verified: without it "GH₵" renders as "GHµ", as it does in the built-in Helvetica).
 */
const FILES = join(process.cwd(), "node_modules", "@fontsource", "ibm-plex-sans", "files");
const file = (subset: string, weight: number) => join(FILES, `ibm-plex-sans-${subset}-${weight}-normal.woff`);

let registered = false;
export function registerFonts(): void {
  if (registered) return;
  for (const [family, subset] of [
    ["Plex", "latin"],
    ["PlexExt", "latin-ext"],
  ] as const) {
    Font.register({
      family,
      fonts: [
        { src: file(subset, 400), fontWeight: 400 },
        { src: file(subset, 600), fontWeight: 600 },
      ],
    });
  }
  // Long words (names, references) wrap where they must instead of being hyphenated.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

export const FONT = ["Plex", "PlexExt"];

export const COLORS = {
  ink: "#1b1a17",
  ink2: "#56534c",
  ink3: "#6b6860",
  line: "#e3e1db",
  subtle: "#f7f6f3",
  critical: "#a6261d",
  positive: "#276749",
};

export const base = StyleSheet.create({
  page: {
    fontFamily: FONT,
    fontSize: 10,
    color: COLORS.ink,
    lineHeight: 1.4,
  },
  school: { fontSize: 13, fontWeight: 600 },
  label: { fontSize: 8.5, color: COLORS.ink2, letterSpacing: 0.6, textTransform: "uppercase" },
  muted: { color: COLORS.ink3 },
  footer: {
    position: "absolute",
    bottom: 28,
    left: 48,
    right: 48,
    fontSize: 8,
    color: COLORS.ink3,
    flexDirection: "row",
    justifyContent: "space-between",
  },
});

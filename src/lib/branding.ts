/**
 * School branding (TEN-04): an accent colour that must keep text readable (WCAG 2.2 AA, 4.5:1 for white text
 * on the colour and for the colour as text on white), and the lighter and darker shades derived from it.
 */

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Readable as a button colour with white text, and as link text on white (AA, 4.5:1). */
export function isAccessibleAccent(hex: string): boolean {
  return isHexColor(hex) && contrastRatio(hex, "#ffffff") >= 4.5;
}

function mix(hex: string, other: string, weight: number): string {
  const a = channels(hex);
  const b = channels(other);
  return `#${a
    .map((c, i) =>
      Math.round(c * (1 - weight) + b[i]! * weight)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** The CSS variables the design system uses for the accent, from one colour. */
export function accentVariables(hex: string): Record<string, string> {
  return {
    "--color-accent": hex,
    "--color-accent-hover": mix(hex, "#000000", 0.2),
    "--color-accent-soft": mix(hex, "#ffffff", 0.9),
  };
}

/**
 * The accent for the dark theme: a lighter shade of the school's colour, readable as text on the dark
 * surfaces and under the deep text used on filled buttons there (AA for any colour that passes
 * `isAccessibleAccent`). The soft tint sits on the dark surface colour from globals.css.
 */
export function darkAccentVariables(hex: string): Record<string, string> {
  return {
    "--color-accent": mix(hex, "#ffffff", 0.6),
    "--color-accent-hover": mix(hex, "#ffffff", 0.7),
    "--color-accent-soft": mix(hex, "#18181b", 0.82),
  };
}

/**
 * A style sheet setting the accent on :root, so dialogs and menus rendered in portals use it too. Each value
 * pairs the light and dark shade with light-dark(), so it follows the theme the page is shown in. Returns an
 * empty string for anything that is not a plain hex colour, so nothing else can reach the page.
 */
export function accentStyleSheet(hex: string | null | undefined): string {
  if (!hex || !isHexColor(hex)) return "";
  const colour = hex.toLowerCase();
  const light = accentVariables(colour);
  const dark = darkAccentVariables(colour);
  const vars = Object.keys(light)
    .map((k) => `${k}:light-dark(${light[k]},${dark[k]})`)
    .join(";");
  return `:root{${vars}}`;
}

/** The public address of a school's logo; the file id busts caches when the logo changes. */
export function schoolLogoUrl(slug: string, logoFileId: string | null | undefined): string | null {
  return logoFileId ? `/logo/${slug}?v=${logoFileId}` : null;
}

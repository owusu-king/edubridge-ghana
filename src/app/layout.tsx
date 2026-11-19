import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import { cookies } from "next/headers";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/toast";
import { explicitTheme, THEME_COOKIE } from "@/lib/theme";
import "./globals.css";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

const display = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-source-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "EduBridge", template: "%s · EduBridge" },
  description: "School management and operations for international and private schools.",
  applicationName: "EduBridge",
  appleWebApp: { capable: true, title: "EduBridge", statusBarStyle: "default" },
  robots: { index: false, follow: false },
};

// The canvas token in each theme (globals.css).
const CANVAS = { light: "#f7f6f3", dark: "#111113" } as const;

export async function generateViewport(): Promise<Viewport> {
  const theme = explicitTheme((await cookies()).get(THEME_COOKIE)?.value);
  return {
    themeColor: theme
      ? CANVAS[theme]
      : [
          { media: "(prefers-color-scheme: light)", color: CANVAS.light },
          { media: "(prefers-color-scheme: dark)", color: CANVAS.dark },
        ],
    width: "device-width",
    initialScale: 1,
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Render every page per request so Next.js can apply the CSP nonce to its scripts.
  await connection();
  const theme = explicitTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en-GH" className={`${sans.variable} ${display.variable}`} data-theme={theme ?? undefined}>
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}

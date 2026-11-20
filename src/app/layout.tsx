import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { SystemThemeWatcher } from "@/components/system-theme-watcher";
import { Toaster } from "@/components/ui/toast";
import { explicitTheme, hintedScheme, SCHEME_HINT, THEME_CANVAS, THEME_COOKIE } from "@/lib/theme";
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

const CANVAS = THEME_CANVAS;

export async function generateViewport(): Promise<Viewport> {
  // The person's choice; for "System", the device's setting when the browser reports it (lib/theme.ts). Only when
  // neither is known does the page carry both colours, for the browser to choose from.
  const theme =
    explicitTheme((await cookies()).get(THEME_COOKIE)?.value) ??
    hintedScheme((await headers()).get(SCHEME_HINT));
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
  // suppressHydrationWarning: browser extensions (ColorZilla, Grammarly, Dark Reader) add attributes to <html> and
  // <body> before React loads. It ignores attribute differences on these two elements only, not on the page inside.
  return (
    <html
      lang="en-GH"
      className={`${sans.variable} ${display.variable}`}
      data-theme={theme ?? undefined}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        {children}
        <Toaster />
        <SystemThemeWatcher />
      </body>
    </html>
  );
}

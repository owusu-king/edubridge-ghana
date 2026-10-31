import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import type { ReactNode } from "react";
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

export const viewport: Viewport = {
  themeColor: "#f7f6f3",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GH" className={`${sans.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}

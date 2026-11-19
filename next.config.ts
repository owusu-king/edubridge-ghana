import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  typedRoutes: true,
  // Server actions receive spreadsheets (imports, up to 2 MB with their parsed rows) and student documents
  // (up to 5 MB; each file's type and size are checked again on the server).
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  serverExternalPackages: ["pg", "@react-pdf/renderer"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The service worker must be re-checked on every visit so fixes reach devices at once.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};

export default nextConfig;

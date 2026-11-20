import type { MetadataRoute } from "next";

/**
 * The web app manifest: what lets EduBridge be installed as an app on phones (home screen) and on computers (its own
 * window, from the Start menu, taskbar or Dock, with no browser bars). The profile menu offers "Install EduBridge"
 * where the browser can do it (src/components/shell/install.ts).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "EduBridge",
    short_name: "EduBridge",
    description: "The complete operating system for schools.",
    id: "/",
    // The installed app opens on sign-in or the person's own pages, never the landing page (app/app/page.tsx).
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#f7f6f3",
    theme_color: "#f7f6f3",
    categories: ["education", "productivity", "business"],
    // Opening EduBridge again brings its window forward instead of starting another one.
    launch_handler: { client_mode: ["focus-existing", "auto"] },
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

import { Play } from "lucide-react";

/*
 * The landing page's short introduction video (2026-11-19). The founder records it; until then the slot shows a
 * labelled placeholder while developing and nothing at all in production, so no visitor sees an empty frame.
 * The video is served by EduBridge itself (put the file in public/, e.g. public/landing/intro.mp4, and set
 * LANDING_VIDEO=/landing/intro.mp4; LANDING_VIDEO_POSTER for its still): the security policy allows no outside
 * media, and a self-hosted file loads nothing until the visitor presses play.
 */

const sameOrigin = (value: string | undefined) => {
  const v = value?.trim();
  return v && v.startsWith("/") && !v.startsWith("//") ? v : null;
};

export function introVideo(env: Record<string, string | undefined> = process.env) {
  return { src: sameOrigin(env.LANDING_VIDEO), poster: sameOrigin(env.LANDING_VIDEO_POSTER) };
}

export function IntroVideo({ src, poster }: { src: string | null; poster: string | null }) {
  if (src)
    return (
      <video
        controls
        preload="none"
        playsInline
        poster={poster ?? undefined}
        className="aspect-video w-full rounded-xl border border-line bg-ink shadow-overlay"
      >
        <source src={src} />
        Your browser cannot play this video.
      </video>
    );
  if (process.env.NODE_ENV === "production") return null;
  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-line-strong bg-surface text-center">
      <span className="flex size-14 items-center justify-center rounded-full border border-line-strong text-ink-3">
        <Play aria-hidden="true" className="size-5 translate-x-px" />
      </span>
      <div className="max-w-sm px-6">
        <p className="text-base font-medium text-ink">The 90-second introduction goes here</p>
        <p className="mt-1 text-sm text-ink-3">
          Shown only while developing. Put the video in public/ and set LANDING_VIDEO, for example
          /landing/intro.mp4. Until then, production shows nothing here.
        </p>
      </div>
    </div>
  );
}

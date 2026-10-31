import Link from "next/link";
import { buttonStyles } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <p className="tabular text-sm font-medium text-ink-3">404</p>
      <h1 className="mt-2 font-display text-xl font-medium">Page not found</h1>
      <p className="mt-2 max-w-sm text-base text-ink-2">
        This page does not exist, or you do not have access to it.
      </p>
      <Link href="/" className={buttonStyles("secondary", "md", "mt-6")}>
        Go to your schools
      </Link>
    </main>
  );
}

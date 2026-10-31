import { Skeleton } from "@/components/ui/layout";

export default function Loading() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading">
      <div className="space-y-3 border-b border-line pb-6">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-72" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}

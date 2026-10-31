export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-ink">
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6">
        <rect width="24" height="24" rx="5" fill="currentColor" />
        <path d="M6 16.5h12M6 12h8M6 7.5h12" stroke="#f7f6f3" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="font-display text-lg font-semibold tracking-tight">EduBridge</span>
    </span>
  );
}

// The Aurelius Code mark: a blue rounded square with a gold rim and an "A".
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="bm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3a57e8" />
          <stop offset="1" stopColor="#6f8cff" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#bm)" />
      <rect x="3.5" y="3.5" width="57" height="57" rx="13" fill="none" stroke="#c9a227" strokeWidth="3" />
      <path d="M32 13 L49 51 H40.5 L37.2 43 H26.8 L23.5 51 H15 Z M29.4 36.5 H34.6 L32 29.5 Z" fill="#fff" />
    </svg>
  );
}

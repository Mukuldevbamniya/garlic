export function GarlicGlyph({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2.4v2.2" />
      <path d="M12 4.6c-1 0-1.7.8-1.7 1.7 0 .5.2 1 .5 1.3-2.4 1.2-4.1 3.6-4.1 6.4 0 3.5 2.4 6.2 5.3 6.2s5.3-2.7 5.3-6.2c0-2.8-1.7-5.2-4.1-6.4.3-.3.5-.8.5-1.3 0-.9-.7-1.7-1.7-1.7Z" />
      <path d="M12 8.6v11.4" />
      <path d="M9.3 10.1c-.9 1.5-1.3 3.3-1.1 5.3" />
      <path d="M14.7 10.1c.9 1.5 1.3 3.3 1.1 5.3" />
      <path d="m9.6 20.4-.9 1.4" />
      <path d="M12 20.8v1.4" />
      <path d="m14.4 20.4.9 1.4" />
    </svg>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-blood">
        <GarlicGlyph size={compact ? 21 : 24} />
      </span>
      <div className="leading-none">
        <div className={`font-serif italic tracking-[-0.01em] text-bone ${compact ? "text-[22px]" : "text-[27px]"}`}>
          Garlic
        </div>
        {!compact ? (
          <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.22em] text-faint">recurring charge hunter</div>
        ) : null}
      </div>
    </div>
  );
}

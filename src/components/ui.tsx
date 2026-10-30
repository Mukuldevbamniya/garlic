import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import type { AlertSeverity, SubscriptionStatus } from "../../shared/types.ts";

export function Panel({
  children,
  className = "",
  raised = false,
}: {
  children: ReactNode;
  className?: string;
  raised?: boolean;
}) {
  return <div className={`${raised ? "panel-raised" : "panel"} ${className}`}>{children}</div>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
      <div className="min-w-0 max-w-[68ch]">
        <div className="eyebrow mb-3">{eyebrow}</div>
        <h1 className="text-[clamp(32px,4.6vw,50px)] leading-[0.95] tracking-[-0.02em] text-bone">{title}</h1>
        {description ? <p className="mt-3 max-w-[60ch] text-[13px] leading-relaxed text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PanelHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line-soft px-5 py-4">
      <div className="min-w-0">
        {eyebrow ? <div className="eyebrow mb-1.5">{eyebrow}</div> : null}
        <div className="truncate text-[15px] text-bone">{title}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SectionHeader({
  title,
  eyebrow,
  action,
  className = "",
}: {
  title: ReactNode;
  eyebrow?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-end justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        {eyebrow ? <div className="eyebrow mb-2">{eyebrow}</div> : null}
        <h2 className="truncate text-[22px] leading-none text-bone">{title}</h2>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  detail,
  accent,
  size = "md",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  accent?: "blood" | "acid" | "bone" | "amber";
  size?: "sm" | "md" | "lg";
}) {
  const color =
    accent === "blood" ? "text-blood" : accent === "acid" ? "text-acid" : accent === "amber" ? "text-amber" : "text-bone";
  const sizeClass = size === "lg" ? "text-[clamp(26px,3vw,40px)]" : size === "sm" ? "text-[20px]" : "text-[28px]";
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-2.5">{label}</div>
      <div className={`num ${sizeClass} ${color} leading-none tracking-[-0.03em]`}>{value}</div>
      {detail ? <div className="mt-2 text-[12px] leading-snug text-muted">{detail}</div> : null}
    </div>
  );
}

const STATUS_TONE: Record<SubscriptionStatus, { label: string; color: string; bg: string; border: string }> = {
  active: { label: "active", color: "var(--color-acid)", bg: "rgba(198,242,78,0.08)", border: "rgba(198,242,78,0.25)" },
  pending_review: { label: "review", color: "var(--color-amber)", bg: "rgba(255,176,46,0.08)", border: "rgba(255,176,46,0.25)" },
  cancelled: { label: "cancelled", color: "var(--color-muted)", bg: "rgba(255,255,255,0.03)", border: "var(--color-line)" },
  lapsed: { label: "lapsed", color: "var(--color-blood)", bg: "rgba(255,74,61,0.08)", border: "rgba(255,74,61,0.28)" },
  ignored: { label: "ignored", color: "var(--color-faint)", bg: "transparent", border: "var(--color-line-soft)" },
};

export function StatusBadge({ status }: { status: SubscriptionStatus }) {
  const tone = STATUS_TONE[status];
  return (
    <span
      className="inline-flex h-[21px] items-center gap-1.5 rounded-[2px] border px-2 font-mono text-[10px] uppercase tracking-[0.1em]"
      style={{ color: tone.color, background: tone.bg, borderColor: tone.border }}
    >
      <span className="h-1 w-1 rounded-full" style={{ background: tone.color }} />
      {tone.label}
    </span>
  );
}

export function SeverityDot({ severity }: { severity: AlertSeverity }) {
  const color = severity === "critical" ? "var(--color-blood)" : severity === "warning" ? "var(--color-amber)" : "var(--color-faint)";
  return <span className="inline-block h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: color }} />;
}

export function Meter({ value, tone }: { value: number; tone?: "acid" | "amber" | "blood" }) {
  const color =
    tone === "blood" || value < 0.6 ? "var(--color-blood)" : tone === "amber" || value < 0.8 ? "var(--color-amber)" : "var(--color-acid)";
  return (
    <div className="flex items-center gap-2">
      <div className="h-[3px] w-full max-w-[76px] overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.round(value * 100)}%`, background: color }} />
      </div>
      <span className="num text-[11px] text-muted">{Math.round(value * 100)}</span>
    </div>
  );
}

export function Empty({
  title,
  body,
  icon,
  action,
}: {
  title: string;
  body: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon ? <div className="text-faint">{icon}</div> : null}
      <div className="text-[15px] text-bone">{title}</div>
      <p className="max-w-[380px] text-[13px] leading-relaxed text-muted">{body}</p>
      {action}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent ${className}`}
      aria-label="Loading"
    />
  );
}

export function Modal({
  open,
  onClose,
  children,
  width = "760px",
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  label: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/72 px-4 py-8 backdrop-blur-[3px] sm:py-14">
      <button type="button" aria-label="Close" className="fixed inset-0 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="animate-rise relative z-10 w-full border border-line bg-surface shadow-[0_40px_120px_-20px_rgba(0,0,0,0.9)]"
        style={{ maxWidth: width }}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 grid h-8 w-8 place-items-center text-muted transition-colors hover:text-bone"
          aria-label="Close dialog"
        >
          <X size={16} />
        </button>
        {children}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  children,
  label,
  width = "440px",
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  label: string;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="animate-rise relative flex h-full w-full flex-col border-l border-line bg-surface shadow-[-30px_0_80px_rgba(0,0,0,0.6)]"
        style={{ maxWidth: width }}
      >
        {children}
      </aside>
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-right text-[13px] text-bone">{children}</span>
    </div>
  );
}

export function MonoTag({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "acid" | "blood" | "amber" }) {
  const color =
    tone === "acid" ? "text-acid" : tone === "blood" ? "text-blood" : tone === "amber" ? "text-amber" : "text-muted";
  return <span className={`font-mono text-[10px] uppercase tracking-[0.12em] ${color}`}>{children}</span>;
}

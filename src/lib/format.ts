import type { Cadence, Subscription } from "../../shared/types.ts";
import { annualizedCents, monthlyEquivalentCents } from "../../shared/detect.ts";

export function money(cents: number, currency = "USD", opts: { cents?: boolean } = {}): string {
  const showCents = opts.cents ?? cents % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  }).format(cents / 100);
}

export function compactMoney(cents: number, currency = "USD"): string {
  const value = cents / 100;
  if (Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  return money(cents, currency, { cents: false });
}

export function percent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function cadenceLabel(cadence: Cadence): string {
  const labels: Record<Cadence, string> = {
    weekly: "weekly",
    biweekly: "every 2 weeks",
    four_weekly: "every 4 weeks",
    monthly: "monthly",
    quarterly: "quarterly",
    semiannual: "every 6 months",
    annual: "annual",
    custom: "custom",
  };
  return labels[cadence];
}

export function cadenceShort(cadence: Cadence): string {
  const labels: Record<Cadence, string> = {
    weekly: "/wk",
    biweekly: "/2wk",
    four_weekly: "/4wk",
    monthly: "/mo",
    quarterly: "/qtr",
    semiannual: "/6mo",
    annual: "/yr",
    custom: "/cycle",
  };
  return labels[cadence];
}

export function annualCost(sub: Pick<Subscription, "amountCents" | "cadence">): number {
  return annualizedCents(sub.amountCents, sub.cadence);
}

export function monthlyCost(sub: Pick<Subscription, "amountCents" | "cadence">): number {
  return monthlyEquivalentCents(sub.amountCents, sub.cadence);
}

export function formatDate(iso: string | null, opts: { withYear?: boolean } = {}): string {
  if (!iso) return "—";
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: opts.withYear ? "numeric" : undefined,
    timeZone: "UTC",
  }).format(date);
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const target = new Date(`${iso.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((target - start) / 86_400_000);
}

export function relativeDay(iso: string | null): string {
  const days = daysUntil(iso);
  if (days === null) return "no date";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

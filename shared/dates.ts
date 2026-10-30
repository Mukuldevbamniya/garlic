/**
 * Calendar math is done in UTC on plain YYYY-MM-DD strings. Bank posting dates
 * have no timezone, and treating them as local time silently shifts month
 * boundaries for users west of UTC, so every helper here is UTC-only.
 */

const MS_PER_DAY = 86_400_000;

export type IsoDate = string;

export function parseIsoDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid ISO date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return Date.UTC(year, month - 1, day);
}

export function toIsoDate(ms: number): IsoDate {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayIso(now: Date = new Date()): IsoDate {
  return toIsoDate(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function addDays(value: IsoDate, days: number): IsoDate {
  return toIsoDate(parseIsoDate(value) + days * MS_PER_DAY);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIsoDate(to) - parseIsoDate(from)) / MS_PER_DAY);
}

export function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Add months while clamping to the last valid day, so a Jan 31 renewal becomes
 * Feb 28 rather than silently rolling into March.
 */
export function addMonthsClamped(value: IsoDate, months: number): IsoDate {
  const date = new Date(parseIsoDate(value));
  const targetMonth = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(targetMonth / 12);
  const monthIndex = ((targetMonth % 12) + 12) % 12;
  const day = Math.min(date.getUTCDate(), lastDayOfMonth(year, monthIndex));
  return toIsoDate(Date.UTC(year, monthIndex, day));
}

export function dayOfMonth(value: IsoDate): number {
  return new Date(parseIsoDate(value)).getUTCDate();
}

export function isLastDayOfMonth(value: IsoDate): boolean {
  const date = new Date(parseIsoDate(value));
  return date.getUTCDate() === lastDayOfMonth(date.getUTCFullYear(), date.getUTCMonth());
}

export function monthKey(value: IsoDate): string {
  return value.slice(0, 7);
}

export function startOfMonth(value: IsoDate): IsoDate {
  return `${value.slice(0, 7)}-01`;
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function formatMoney(cents: number, currency: string, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function formatDateShort(value: IsoDate): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(parseIsoDate(value)));
}

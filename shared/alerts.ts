import { daysBetween, formatMoney, todayIso } from "./dates.ts";
import { annualizedCents, monthlyEquivalentCents } from "./detect.ts";
import type { AlertKind, AlertSeverity, Subscription } from "./types.ts";

export interface AlertDraft {
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  dueAt: string | null;
  subscriptionId: string | null;
  dedupeKey: string;
}

export interface AlertOptions {
  today?: string;
  leadDays?: number;
  zombieAfterDays?: number;
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Only categories where one plan genuinely replaces another. Netflix + Disney+
 * is a choice, not a duplicate; two cloud storage plans is money on fire.
 */
const CATEGORY_OVERLAPS = new Set(["Cloud storage", "AI tools", "Music"]);

export function buildAlerts(subscriptions: Subscription[], options: AlertOptions = {}): AlertDraft[] {
  const today = options.today ?? todayIso();
  const leadDays = options.leadDays ?? 3;
  const zombieAfterDays = options.zombieAfterDays ?? 60;
  const drafts: AlertDraft[] = [];
  const active = subscriptions.filter((sub) => sub.status === "active" || sub.status === "pending_review");

  for (const sub of active) {
    if (sub.nextChargeAt) {
      const daysUntil = daysBetween(today, sub.nextChargeAt);
      const annual = sub.cadence === "annual";
      const window = annual ? Math.max(leadDays, 30) : leadDays;
      if (daysUntil >= 0 && daysUntil <= window) {
        const amount = formatMoney(sub.amountCents, sub.currency);
        drafts.push({
          kind: annual ? "annual_renewal" : "renewal",
          severity: annual || sub.amountCents >= 10_000 ? "warning" : "info",
          title: annual
            ? `${sub.displayName} renews for a year in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`
            : `${sub.displayName} charges ${amount} in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`,
          body: annual
            ? `${amount} for 12 months on ${sub.nextChargeAt}. Annual plans usually have a short refund window, so decide before the charge lands.`
            : `${amount} on ${sub.nextChargeAt}. Cancel before then to avoid the charge${sub.noticePeriodDays > 0 ? `; this provider needs ${sub.noticePeriodDays} days' notice` : ""}.`,
          dueAt: sub.nextChargeAt,
          subscriptionId: sub.id,
          dedupeKey: `${sub.id}:renewal:${sub.nextChargeAt}`,
        });
      }
    }

    if (sub.priceChange && daysBetween(sub.priceChange.at, today) <= 45) {
      const direction = sub.priceChange.deltaPct > 0 ? "increased" : "decreased";
      drafts.push({
        kind: "price_increase",
        severity: sub.priceChange.deltaPct > 0 ? "warning" : "info",
        title: `${sub.displayName} ${direction} ${Math.abs(sub.priceChange.deltaPct).toFixed(0)}%`,
        body: `Went from ${formatMoney(sub.priceChange.fromCents, sub.currency)} to ${formatMoney(sub.priceChange.toCents, sub.currency)} on ${sub.priceChange.at}. That is ${formatMoney(annualizedCents(sub.priceChange.toCents - sub.priceChange.fromCents, sub.cadence), sub.currency)} a year at the new price.`,
        dueAt: sub.priceChange.at,
        subscriptionId: sub.id,
        dedupeKey: `${sub.id}:price:${sub.priceChange.at}:${sub.priceChange.toCents}`,
      });
    }

    if (sub.lastUsedAt) {
      const idleDays = daysBetween(sub.lastUsedAt, today);
      if (idleDays >= zombieAfterDays && monthlyEquivalentCents(sub.amountCents, sub.cadence) >= 500) {
        drafts.push({
          kind: "zombie",
          severity: "warning",
          title: `${sub.displayName} is a zombie`,
          body: `No usage in ${idleDays} days, but it still bills ${formatMoney(sub.amountCents, sub.currency)} ${sub.cadence === "annual" ? "a year" : "per cycle"}. That is ${formatMoney(annualizedCents(sub.amountCents, sub.cadence), sub.currency)} a year for something you are not using.`,
          dueAt: null,
          subscriptionId: sub.id,
          dedupeKey: `${sub.id}:zombie:${sub.lastUsedAt}`,
        });
      }
    }
  }

  for (const sub of subscriptions) {
    if (sub.status !== "lapsed") continue;
    drafts.push({
      kind: "failed_charge",
      severity: "warning",
      title: `${sub.displayName} looks lapsed`,
      body: `No charge since ${sub.lastSeen}, which is past the expected ${sub.cadence.replace("_", "-")} cycle. Either it was cancelled, the card failed, or the plan changed. Worth a look.`,
      dueAt: null,
      subscriptionId: sub.id,
      dedupeKey: `${sub.id}:lapsed:${sub.lastSeen}`,
    });
  }

  // Overlapping services: two active subscriptions solving the same problem.
  const byCategory = new Map<string, Subscription[]>();
  for (const sub of active) {
    if (!CATEGORY_OVERLAPS.has(sub.category)) continue;
    const list = byCategory.get(sub.category) ?? [];
    list.push(sub);
    byCategory.set(sub.category, list);
  }
  for (const [category, list] of byCategory) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(
      (a, b) => monthlyEquivalentCents(b.amountCents, b.cadence) - monthlyEquivalentCents(a.amountCents, a.cadence),
    );
    const drop = sorted[0]!;
    const keep = sorted[sorted.length - 1]!;
    drafts.push({
      kind: "duplicate_service",
      severity: "info",
      title: `Two ${category.toLowerCase()} subscriptions`,
      body: `You pay for both ${keep.displayName} and ${drop.displayName}. Dropping ${drop.displayName} saves ${formatMoney(annualizedCents(drop.amountCents, drop.cadence), drop.currency)} a year.`,
      dueAt: null,
      subscriptionId: drop.id,
      dedupeKey: `${category}:duplicate:${sorted.map((sub) => sub.id).join("+")}`,
    });
  }

  return drafts.sort((a, b) => {
    const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severity !== 0) return severity;
    if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return a.title.localeCompare(b.title);
  });
}

export function potentialSavingsCents(subscriptions: Subscription[], today = todayIso()): number {
  let total = 0;
  const counted = new Set<string>();
  const active = subscriptions.filter((sub) => sub.status === "active" || sub.status === "pending_review");
  for (const sub of active) {
    if (sub.lastUsedAt && daysBetween(sub.lastUsedAt, today) >= 60) {
      total += annualizedCents(sub.amountCents, sub.cadence);
      counted.add(sub.id);
    }
  }
  const byCategory = new Map<string, Subscription[]>();
  for (const sub of active) {
    if (!CATEGORY_OVERLAPS.has(sub.category)) continue;
    const list = byCategory.get(sub.category) ?? [];
    list.push(sub);
    byCategory.set(sub.category, list);
  }
  for (const list of byCategory.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(
      (a, b) => monthlyEquivalentCents(b.amountCents, b.cadence) - monthlyEquivalentCents(a.amountCents, a.cadence),
    );
    const drop = sorted[0]!;
    if (counted.has(drop.id)) continue;
    total += annualizedCents(drop.amountCents, drop.cadence);
    counted.add(drop.id);
  }
  return total;
}

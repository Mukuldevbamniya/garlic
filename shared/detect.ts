import {
  addDays,
  addMonthsClamped,
  dayOfMonth,
  daysBetween,
  isLastDayOfMonth,
  lastDayOfMonth,
  parseIsoDate,
  todayIso,
} from "./dates.ts";
import { catalogProfile, matchCatalog } from "./catalog.ts";
import type {
  BillingModel,
  Cadence,
  Currency,
  DetectionReason,
  PriceChange,
  Subscription,
  Transaction,
} from "./types.ts";

export type DetectionResult = Omit<
  Subscription,
  "id" | "createdAt" | "updatedAt" | "userRenamed" | "lastUsedAt"
>;

interface CadenceSpec {
  cadence: Cadence;
  /** Mean length in days; used to normalise gaps for calendar cycles too. */
  days: number;
  months: number | null;
  /** Allowed drift per cycle, in days. */
  tolerance: number;
  minOccurrences: number;
  /** Score for the expected number of observations at this cadence. */
  countScore: (n: number) => number;
}

const linear = (steps: Array<[number, number]>, fallback: number) => (n: number) => {
  for (const [atLeast, score] of steps) if (n >= atLeast) return score;
  return fallback;
};

const SPECS: CadenceSpec[] = [
  {
    cadence: "weekly",
    days: 7,
    months: null,
    tolerance: 1.2,
    minOccurrences: 4,
    countScore: linear([[12, 1], [8, 0.96], [6, 0.9], [4, 0.74]], 0.4),
  },
  {
    cadence: "biweekly",
    days: 14,
    months: null,
    tolerance: 1.8,
    minOccurrences: 3,
    countScore: linear([[10, 1], [6, 0.95], [4, 0.82], [3, 0.64]], 0.35),
  },
  {
    cadence: "four_weekly",
    days: 28,
    months: null,
    tolerance: 2,
    minOccurrences: 3,
    countScore: linear([[10, 1], [6, 0.95], [4, 0.82], [3, 0.64]], 0.35),
  },
  {
    cadence: "monthly",
    days: 30.44,
    months: 1,
    tolerance: 4.5,
    minOccurrences: 3,
    countScore: linear([[12, 1], [9, 0.95], [6, 0.88], [5, 0.8], [4, 0.7], [3, 0.56]], 0.3),
  },
  {
    cadence: "quarterly",
    days: 91.31,
    months: 3,
    tolerance: 8,
    minOccurrences: 2,
    countScore: linear([[8, 1], [5, 0.92], [3, 0.8], [2, 0.56]], 0.3),
  },
  {
    cadence: "semiannual",
    days: 182.62,
    months: 6,
    tolerance: 12,
    minOccurrences: 2,
    countScore: linear([[6, 1], [4, 0.92], [3, 0.84], [2, 0.66]], 0.35),
  },
  {
    cadence: "annual",
    days: 365.25,
    months: 12,
    tolerance: 20,
    minOccurrences: 2,
    countScore: linear([[5, 1], [3, 0.92], [2, 0.72]], 0.35),
  },
];

export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  four_weekly: "Every 4 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Every 6 months",
  annual: "Annual",
  custom: "Custom",
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
};

const mad = (values: number[], center: number): number =>
  median(values.map((value) => Math.abs(value - center)));

const weekday = (iso: string): number => new Date(parseIsoDate(iso)).getUTCDay();

/**
 * For calendar-anchored cycles the "day of month" is the stable thing, not the
 * gap. A subscription charged on the 31st lands on the 28th in February and is
 * still the same subscription.
 */
function effectiveAnchorDay(iso: string): number {
  return isLastDayOfMonth(iso) ? 31 : dayOfMonth(iso);
}

interface GroupInput {
  merchantKey: string;
  currency: Currency;
  charges: Transaction[];
  refunds: Transaction[];
}

interface Fit {
  spec: CadenceSpec;
  confidence: number;
  intervalScore: number;
  amountScore: number;
  countScore: number;
  recencyScore: number;
  anchorScore: number;
  violations: number;
  medianGap: number;
  gaps: number[];
  reasons: DetectionReason[];
  billingModel: BillingModel;
  priceChange: PriceChange | null;
  nextChargeAt: string | null;
  anchorDay: number | null;
  amountCents: number;
  medianAmountCents: number;
  alternatives: Array<{ cadence: Cadence; confidence: number }>;
}

function fitCadence(group: GroupInput, spec: CadenceSpec, today: string): Fit | null {
  const charges = group.charges;
  const n = charges.length;
  if (n < spec.minOccurrences) return null;

  const gaps: number[] = [];
  for (let i = 1; i < n; i += 1) {
    gaps.push(daysBetween(charges[i - 1]!.postedAt, charges[i]!.postedAt));
  }
  if (gaps.length === 0) return null;

  // A gap longer than two cycles means the subscription stopped and restarted;
  // treat it as a separate streak rather than one cadence.
  const longestAllowed = spec.days * 2.2 + spec.tolerance;
  if (gaps.some((gap) => gap > longestAllowed)) return null;

  let violations = 0;
  let errorSum = 0;
  let indexSum = 0;
  for (const gap of gaps) {
    const index = Math.max(1, Math.round(gap / spec.days));
    const expected = spec.days * index;
    const allowed = spec.tolerance + 1.5 * (index - 1);
    const error = Math.abs(gap - expected);
    errorSum += Math.min(1, error / allowed);
    indexSum += index;
    if (error > allowed) violations += 1;
  }
  if (violations > Math.floor(gaps.length / 2)) return null;

  const intervalScore = clamp01(1 - errorSum / gaps.length);
  if (intervalScore < 0.5) return null;

  const amounts = charges.map((charge) => charge.amountCents);
  const medianAmountCents = median(amounts);
  const amountSpread = medianAmountCents === 0 ? 0 : mad(amounts, medianAmountCents) / medianAmountCents;
  const billingModel: BillingModel = amountSpread > 0.06 ? "variable" : "fixed";
  const amountScore = clamp01(1 - amountSpread / (billingModel === "variable" ? 0.35 : 0.08));

  const countScore = spec.countScore(n);

  const lastSeen = charges[n - 1]!.postedAt;
  const cyclesSinceLast = daysBetween(lastSeen, today) / spec.days;
  const recencyScore = cyclesSinceLast <= 1.25 ? 1 : cyclesSinceLast <= 2.2 ? 0.55 : 0.1;

  let anchorScore = 1;
  let anchorDay: number | null = null;
  if (spec.cadence === "monthly") {
    const days = charges.map((charge) => effectiveAnchorDay(charge.postedAt));
    const center = median(days);
    anchorDay = center;
    anchorScore = clamp01(1 - mad(days, center) / 4);
  } else if (spec.months === null) {
    const weekdays = charges.map((charge) => weekday(charge.postedAt));
    const center = median(weekdays);
    anchorScore = clamp01(1 - mad(weekdays, center) / 2);
  }

  const reasons: DetectionReason[] = [];
  reasons.push({
    code: "interval",
    label: "Interval fit",
    detail: `${gaps.length} gap${gaps.length === 1 ? "" : "s"} averaging ${Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)} days, matching a ${spec.days.toFixed(0)}-day cycle`,
    weight: Number((intervalScore * 0.32).toFixed(3)),
  });
  reasons.push({
    code: "amount",
    label: billingModel === "variable" ? "Usage-based amount" : "Stable amount",
    detail:
      billingModel === "variable"
        ? `Amounts vary by ${Math.round(amountSpread * 100)}% around a median of ${(medianAmountCents / 100).toFixed(2)}`
        : `Charges cluster around ${(medianAmountCents / 100).toFixed(2)} with ${Math.round(amountSpread * 100)}% spread`,
    weight: Number((amountScore * 0.24).toFixed(3)),
  });
  reasons.push({
    code: "occurrences",
    label: "Repeat count",
    detail: `${n} charges observed`,
    weight: Number((countScore * 0.2).toFixed(3)),
  });
  reasons.push({
    code: "recency",
    label: "Still live",
    detail:
      cyclesSinceLast <= 1.25
        ? `Last charged ${Math.round(daysBetween(lastSeen, today))} days ago`
        : `Last charged ${Math.round(cyclesSinceLast)} cycles ago`,
    weight: Number((recencyScore * 0.14).toFixed(3)),
  });
  if (spec.cadence === "monthly" && anchorDay !== null) {
    reasons.push({
      code: "anchor",
      label: "Billing anchor",
      detail: `Charges land on day ${anchorDay} of the month`,
      weight: Number((anchorScore * 0.1).toFixed(3)),
    });
  } else if (spec.months === null) {
    reasons.push({
      code: "anchor",
      label: "Weekday anchor",
      detail: "Charges land on the same weekday",
      weight: Number((anchorScore * 0.1).toFixed(3)),
    });
  } else {
    reasons.push({
      code: "anchor",
      label: "Calendar anchor",
      detail: `Repeats every ${spec.months} months`,
      weight: 0.1,
    });
  }

  const catalogHit = matchCatalog(charges[0]!.rawDescriptor);
  if (catalogHit) {
    reasons.push({
      code: "merchant",
      label: "Known subscription merchant",
      detail: `${catalogHit.displayName} is a known recurring service`,
      weight: 0.05,
    });
  } else if (amountSpread > 0.02) {
    // An unrecognised merchant whose amounts drift is far more likely to be a
    // habit (coffee, groceries, rides) than a subscription. Known services are
    // exempt because usage-based billing (AWS, metered APIs) legitimately varies.
    reasons.push({
      code: "unknown_variable",
      label: "Unrecognised merchant with variable amounts",
      detail: "No subscription signal in the merchant name, and the amount is not stable",
      weight: -0.22,
    });
  }

  // Price changes are detected against the median of everything before the last
  // charge, so a single step-up does not look like an unstable amount.
  let priceChange: PriceChange | null = null;
  if (n >= 3 && billingModel === "fixed") {
    const prior = charges.slice(0, -1).map((charge) => charge.amountCents);
    const priorMedian = median(prior);
    const latest = charges[n - 1]!.amountCents;
    if (priorMedian > 0) {
      const deltaPct = (latest - priorMedian) / priorMedian;
      if (Math.abs(deltaPct) >= 0.02 && Math.abs(latest - priorMedian) >= 100) {
        priceChange = {
          fromCents: priorMedian,
          toCents: latest,
          at: lastSeen,
          deltaPct: Number((deltaPct * 100).toFixed(1)),
        };
        reasons.push({
          code: "price_change",
          label: deltaPct > 0 ? "Price increase" : "Price decrease",
          detail: `${(priorMedian / 100).toFixed(2)} → ${(latest / 100).toFixed(2)} on ${lastSeen} (${deltaPct > 0 ? "+" : ""}${(deltaPct * 100).toFixed(0)}%)`,
          weight: 0,
        });
      }
    }
  }

  if (group.refunds.length > 0) {
    reasons.push({
      code: "refund",
      label: "Refund on record",
      detail: `${group.refunds.length} refund${group.refunds.length === 1 ? "" : "s"} from this merchant`,
      weight: -0.04,
    });
  }

  if (indexSum > gaps.length * 1.25) {
    reasons.push({
      code: "gaps",
      label: "Skipped cycles",
      detail: "One or more expected charges are missing",
      weight: -0.03,
    });
  }

  // Models that need "skipped cycles" to explain a gap are less parsimonious
  // than one that matches the observed period directly. Without this, a 28-day
  // cycle scores identically as biweekly (2x14) and four-weekly (1x28).
  const skippedCycles = Math.max(0, (indexSum - gaps.length) / gaps.length);
  const parsimonyPenalty = Math.min(0.18, skippedCycles * 0.12);

  const raw =
    intervalScore * 0.32 +
    amountScore * 0.24 +
    countScore * 0.2 +
    recencyScore * 0.14 +
    anchorScore * 0.1 +
    (catalogHit ? 0.05 : 0) +
    (!catalogHit && amountSpread > 0.02 ? -0.22 : 0) +
    (group.refunds.length > 0 ? -0.04 : 0) +
    (indexSum > gaps.length * 1.25 ? -0.03 : 0) -
    parsimonyPenalty;
  const confidence = clamp01(raw);

  return {
    spec,
    confidence,
    intervalScore,
    amountScore,
    countScore,
    recencyScore,
    anchorScore,
    violations,
    medianGap: median(gaps),
    gaps,
    reasons,
    billingModel,
    priceChange,
    nextChargeAt: null,
    anchorDay,
    amountCents: charges[n - 1]!.amountCents,
    medianAmountCents,
    alternatives: [],
  };
}

function projectNextCharge(
  lastSeen: string,
  spec: CadenceSpec,
  anchorDay: number | null,
  today: string,
): { nextChargeAt: string; overdueDays: number } {
  if (spec.months === null) {
    const elapsed = daysBetween(lastSeen, today);
    const cycles = Math.max(1, Math.floor(elapsed / spec.days) + 1);
    const nextChargeAt = addDays(lastSeen, cycles * spec.days);
    const expectedAt = addDays(lastSeen, spec.days);
    return { nextChargeAt, overdueDays: Math.max(0, daysBetween(expectedAt, today)) };
  }

  const day = anchorDay ?? dayOfMonth(lastSeen);
  const anchorMonth = lastSeen.slice(0, 7);
  const [yearText, monthText] = anchorMonth.split("-");
  const baseYear = Number(yearText);
  const baseMonth = Number(monthText) - 1;

  for (let step = 1; step <= 48; step += 1) {
    const totalMonth = baseMonth + step * spec.months;
    const year = baseYear + Math.floor(totalMonth / 12);
    const monthIndex = ((totalMonth % 12) + 12) % 12;
    const clampedDay = Math.min(day, lastDayOfMonth(year, monthIndex));
    const candidate = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
    if (daysBetween(candidate, today) < 0) {
      const expected = addMonthsClamped(lastSeen, spec.months);
      return { nextChargeAt: candidate, overdueDays: Math.max(0, daysBetween(expected, today)) };
    }
  }
  const fallback = addMonthsClamped(lastSeen, spec.months);
  return { nextChargeAt: fallback, overdueDays: Math.max(0, daysBetween(fallback, today)) };
}

/**
 * A single annual fee, tax adjustment or one-off purchase at the same merchant
 * can hide an otherwise clean cadence. Drop charges that are far off the median
 * amount and retry — but only when the direct fit failed, so usage-based billing
 * is never quietly trimmed.
 */
function filterAmountOutliers(charges: Transaction[]): Transaction[] {
  const center = median(charges.map((charge) => charge.amountCents));
  if (center <= 0) return charges;
  const kept = charges.filter((charge) => Math.abs(charge.amountCents - center) / center <= 0.25);
  return kept.length >= 4 ? kept : charges;
}

function clusterByAmount(charges: Transaction[]): Transaction[][] {
  const sorted = [...charges].sort((a, b) => a.amountCents - b.amountCents);
  const clusters: Transaction[][] = [];
  for (const charge of sorted) {
    const current = clusters[clusters.length - 1];
    if (!current) {
      clusters.push([charge]);
      continue;
    }
    const center = median(current.map((item) => item.amountCents));
    const tolerance = Math.max(50, center * 0.03);
    if (Math.abs(charge.amountCents - center) <= tolerance) current.push(charge);
    else clusters.push([charge]);
  }
  return clusters.filter((cluster) => cluster.length >= 2);
}

function detectGroup(group: GroupInput, today: string): Fit | null {
  const fits = SPECS.map((spec) => fitCadence(group, spec, today)).filter(
    (fit): fit is Fit => fit !== null,
  );
  if (fits.length === 0) return null;
  fits.sort((a, b) => b.confidence - a.confidence);
  const best = fits[0]!;
  const runnerUp = fits[1];

  // A 28-day cycle and a calendar month look nearly identical over a short
  // window. When they disagree, prefer the one whose anchor is stable and flag
  // the result for review instead of pretending to be certain.
  const ambiguous = runnerUp !== undefined && best.confidence - runnerUp.confidence < 0.05;
  if (ambiguous) {
    best.reasons.push({
      code: "ambiguous",
      label: "Close second match",
      detail: `Also fits a ${CADENCE_LABEL[runnerUp.spec.cadence].toLowerCase()} cycle (${Math.round(runnerUp.confidence * 100)}%)`,
      weight: 0,
    });
  }

  best.alternatives = fits
    .filter((fit) => fit.spec.cadence !== best.spec.cadence && best.confidence - fit.confidence < 0.25)
    .slice(0, 2)
    .map((fit) => ({ cadence: fit.spec.cadence, confidence: Number(fit.confidence.toFixed(3)) }));

  const accepted = best.confidence >= 0.6 && best.intervalScore >= 0.55;
  if (!accepted) return null;

  const { nextChargeAt } = projectNextCharge(
    group.charges[group.charges.length - 1]!.postedAt,
    best.spec,
    best.anchorDay,
    today,
  );

  return { ...best, nextChargeAt };
}

export interface DetectOptions {
  today?: string;
  minConfidence?: number;
}

export function detectSubscriptions(
  transactions: Transaction[],
  options: DetectOptions = {},
): DetectionResult[] {
  const today = options.today ?? todayIso();
  const minConfidence = options.minConfidence ?? 0.6;

  const groups = new Map<string, GroupInput>();
  for (const transaction of transactions) {
    if (transaction.isPending) continue;
    const key = `${transaction.merchantKey}::${transaction.currency}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        merchantKey: transaction.merchantKey,
        currency: transaction.currency,
        charges: [],
        refunds: [],
      };
      groups.set(key, group);
    }
    if (transaction.amountCents > 0) group.charges.push(transaction);
    else group.refunds.push(transaction);
  }

  const results: DetectionResult[] = [];
  for (const group of groups.values()) {
    // Collapse exact duplicate postings (same day, same amount) so a double-post
    // does not read as two cycles.
    const seen = new Set<string>();
    group.charges = group.charges
      .filter((charge) => {
        const fingerprint = `${charge.postedAt}:${charge.amountCents}`;
        if (seen.has(fingerprint)) return false;
        seen.add(fingerprint);
        return true;
      })
      .sort((a, b) => a.postedAt.localeCompare(b.postedAt));

    if (group.charges.length < 2) continue;

    let fits: Array<{ fit: Fit; charges: Transaction[] }> = [];
    const direct = detectGroup(group, today);
    if (direct) fits.push({ fit: direct, charges: group.charges });

    if (!direct) {
      const trimmed = filterAmountOutliers(group.charges);
      if (trimmed.length !== group.charges.length) {
        const fit = detectGroup({ ...group, charges: trimmed }, today);
        if (fit) {
          fit.reasons.push({
            code: "outlier",
            label: "Fee excluded",
            detail: `${group.charges.length - trimmed.length} charge${group.charges.length - trimmed.length === 1 ? "" : "s"} ignored as a one-off fee or purchase`,
            weight: 0,
          });
          fits.push({ fit, charges: trimmed });
        }
      }
    }

    // Descriptors like APPLE.COM/BILL bundle several services under one name.
    // When one cadence cannot explain the group, split by amount band and treat
    // each band as its own subscription.
    const amounts = group.charges.map((charge) => charge.amountCents);
    const spread = mad(amounts, median(amounts)) / Math.max(1, median(amounts));
    if ((fits.length === 0 || (direct && direct.confidence < 0.72)) && spread > 0.05 && group.charges.length >= 5) {
      const bands = clusterByAmount(group.charges);
      if (bands.length > 1) {
        const bandFits = bands
          .map((charges) => {
            const bandGroup: GroupInput = { ...group, charges, refunds: [] };
            const fit = detectGroup(bandGroup, today);
            return fit ? { fit, charges } : null;
          })
          .filter((value): value is { fit: Fit; charges: Transaction[] } => value !== null);
        if (bandFits.length > fits.length || bandFits.some((band) => band.fit.confidence > (direct?.confidence ?? 0))) {
          fits = bandFits;
        }
      }
    }

    for (const { fit, charges } of fits) {
      if (fit.confidence < minConfidence) continue;
      const profile = catalogProfile(charges[charges.length - 1]!.rawDescriptor, group.merchantKey);
      const lastSeen = charges[charges.length - 1]!.postedAt;
      const expectedNext = projectNextCharge(lastSeen, fit.spec, fit.anchorDay, today);
      const cycleDays = fit.spec.days;
      const sinceLast = daysBetween(lastSeen, today);
      const lapsed = sinceLast > cycleDays * 1.6 + 3;
      const needsReview =
        fit.confidence < 0.74 ||
        (charges.length < 4 && (fit.spec.months === null || fit.spec.months === 1)) ||
        fit.reasons.some((reason) => reason.code === "ambiguous") ||
        profile.cancellationChannel === "unknown";

      results.push({
        merchantKey: group.merchantKey,
        displayName: profile.displayName,
        category: profile.category,
        currency: group.currency,
        amountCents: fit.amountCents,
        medianAmountCents: fit.medianAmountCents,
        cadence: fit.spec.cadence,
        intervalDays: fit.spec.months === null ? Math.round(fit.medianGap) : null,
        billingModel: fit.billingModel,
        confidence: Number(fit.confidence.toFixed(3)),
        status: lapsed ? "lapsed" : needsReview ? "pending_review" : "active",
        firstSeen: charges[0]!.postedAt,
        lastSeen,
        nextChargeAt: lapsed ? null : expectedNext.nextChargeAt,
        occurrences: charges.length,
        priceChange: fit.priceChange,
        cancellationChannel: profile.cancellationChannel,
        cancellationUrl: profile.cancellationUrl,
        tosNote: profile.tosNote,
        noticePeriodDays: profile.noticePeriodDays,
        earlyTerminationFeeCents: profile.earlyTerminationFeeCents,
        reasons: fit.reasons,
        alternatives: fit.alternatives,
        evidenceIds: charges.map((charge) => charge.id),
        needsReview,
      });
    }
  }

  // Fill in runner-up cadences for the UI, now that all results are known.
  return results.sort((a, b) => b.amountCents - a.amountCents);
}

export function annualizedCents(amountCents: number, cadence: Cadence): number {
  switch (cadence) {
    case "weekly":
      return amountCents * 52;
    case "biweekly":
      return amountCents * 26;
    case "four_weekly":
      return amountCents * 13;
    case "monthly":
      return amountCents * 12;
    case "quarterly":
      return amountCents * 4;
    case "semiannual":
      return amountCents * 2;
    case "annual":
      return amountCents;
    case "custom":
      return amountCents * 12;
  }
}

export function monthlyEquivalentCents(amountCents: number, cadence: Cadence): number {
  return Math.round(annualizedCents(amountCents, cadence) / 12);
}

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { detectSubscriptions, type DetectionResult } from "../shared/detect.ts";
import { buildAlerts } from "../shared/alerts.ts";
import { todayIso } from "../shared/dates.ts";
import { allSettings, appendAudit, setMeta, sha256 } from "./db.ts";
import { listSubscriptions } from "./store.ts";
import type { Subscription } from "../shared/types.ts";

interface DetectionSummary {
  created: number;
  updated: number;
  lapsed: number;
  alerts: number;
  detected: DetectionResult[];
}

function disambiguateNames(results: DetectionResult[]): DetectionResult[] {
  const groups = new Map<string, DetectionResult[]>();
  for (const result of results) {
    const key = `${result.merchantKey}::${result.currency}`;
    const list = groups.get(key) ?? [];
    list.push(result);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (const result of list) {
      const amount = (result.amountCents / 100).toFixed(2);
      result.displayName = `${result.displayName} · $${amount}`;
    }
  }
  return results;
}

function matchExisting(result: DetectionResult, existing: Subscription[]): Subscription | null {
  const candidates = existing.filter(
    (sub) =>
      sub.merchantKey === result.merchantKey &&
      sub.currency === result.currency &&
      sub.status !== "cancelled" &&
      sub.status !== "ignored",
  );
  const exact = candidates.find((sub) => sub.amountCents === result.amountCents);
  if (exact) return exact;
  const close = candidates
    .filter((sub) => Math.abs(sub.amountCents - result.amountCents) / Math.max(1, result.amountCents) <= 0.15)
    .sort((a, b) => Math.abs(a.amountCents - result.amountCents) - Math.abs(b.amountCents - result.amountCents));
  return close[0] ?? null;
}

const UPSERT_COLUMNS = [
  "merchant_key",
  "display_name",
  "category",
  "currency",
  "amount_cents",
  "median_amount_cents",
  "cadence",
  "interval_days",
  "billing_model",
  "confidence",
  "status",
  "first_seen",
  "last_seen",
  "next_charge_at",
  "occurrences",
  "price_change_json",
  "cancellation_channel",
  "cancellation_url",
  "tos_note",
  "notice_period_days",
  "early_termination_fee_cents",
  "reasons_json",
  "alternatives_json",
  "evidence_json",
  "needs_review",
  "user_renamed",
  "updated_at",
] as const;

function writeSubscription(
  db: DatabaseSync,
  result: DetectionResult,
  existing: Subscription | null,
): { id: string; action: "created" | "updated" } {
  const now = new Date().toISOString();
  const displayName = existing?.userRenamed ? existing.displayName : result.displayName;
  const values: Record<(typeof UPSERT_COLUMNS)[number], string | number | null> = {
    merchant_key: result.merchantKey,
    display_name: displayName,
    category: result.category,
    currency: result.currency,
    amount_cents: result.amountCents,
    median_amount_cents: result.medianAmountCents,
    cadence: result.cadence,
    interval_days: result.intervalDays,
    billing_model: result.billingModel,
    confidence: result.confidence,
    status: result.status,
    first_seen: result.firstSeen,
    last_seen: result.lastSeen,
    next_charge_at: result.nextChargeAt,
    occurrences: result.occurrences,
    price_change_json: result.priceChange ? JSON.stringify(result.priceChange) : null,
    cancellation_channel: result.cancellationChannel,
    cancellation_url: result.cancellationUrl,
    tos_note: result.tosNote,
    notice_period_days: result.noticePeriodDays,
    early_termination_fee_cents: result.earlyTerminationFeeCents,
    reasons_json: JSON.stringify(result.reasons),
    alternatives_json: JSON.stringify(result.alternatives),
    evidence_json: JSON.stringify(result.evidenceIds),
    needs_review: result.needsReview ? 1 : 0,
    user_renamed: existing?.userRenamed ? 1 : 0,
    updated_at: now,
  };

  if (existing) {
    const assignments = UPSERT_COLUMNS.map((column) => `${column} = ?`).join(", ");
    db.prepare(`UPDATE subscriptions SET ${assignments} WHERE id = ?`).run(
      ...UPSERT_COLUMNS.map((column) => values[column]),
      existing.id,
    );
    return { id: existing.id, action: "updated" };
  }

  const id = randomUUID();
  const columns = ["id", ...UPSERT_COLUMNS, "last_used_at", "created_at"];
  const placeholders = columns.map(() => "?").join(", ");
  db.prepare(`INSERT INTO subscriptions (${columns.join(", ")}) VALUES (${placeholders})`).run(
    id,
    ...UPSERT_COLUMNS.map((column) => values[column]),
    null,
    now,
  );
  return { id, action: "created" };
}

export function runDetection(db: DatabaseSync, today = todayIso()): DetectionSummary {
  const settings = allSettings(db);
  const transactions = db
    .prepare("SELECT * FROM transactions ORDER BY posted_at ASC")
    .all() as Array<Record<string, unknown>>;

  const mapped = transactions.map((row) => ({
    id: String(row.id),
    accountId: String(row.account_id),
    postedAt: String(row.posted_at),
    amountCents: Number(row.amount_cents),
    currency: String(row.currency) as Subscription["currency"],
    rawDescriptor: String(row.raw_descriptor),
    merchantKey: String(row.merchant_key),
    merchantName: String(row.merchant_name),
    category: String(row.category),
    isPending: Number(row.is_pending) === 1,
    source: String(row.source) as "demo" | "csv" | "manual",
    externalId: row.external_id === null ? null : String(row.external_id),
  }));

  const results = disambiguateNames(detectSubscriptions(mapped, { today }));
  const existing = listSubscriptions(db);
  const touched = new Set<string>();
  let created = 0;
  let updated = 0;

  for (const result of results) {
    const match = matchExisting(result, existing);
    const { id, action } = writeSubscription(db, result, match);
    touched.add(id);
    if (action === "created") created += 1;
    else updated += 1;
  }

  // Anything that used to be live but no longer has evidence becomes lapsed,
  // never deleted — the history and the audit trail stay intact.
  let lapsed = 0;
  for (const sub of existing) {
    if (touched.has(sub.id)) continue;
    if (sub.status === "active" || sub.status === "pending_review") {
      db.prepare("UPDATE subscriptions SET status = 'lapsed', next_charge_at = NULL, updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        sub.id,
      );
      lapsed += 1;
    }
  }

  const alertCount = refreshAlerts(db, today);
  setMeta(db, "last_detected_at", new Date().toISOString());
  appendAudit(db, {
    actor: "system",
    action: "detection.run",
    subject: "transaction history",
    detail: {
      transactions: mapped.length,
      detected: results.length,
      created,
      updated,
      lapsed,
      alerts: alertCount,
      leadDays: settings.alertLeadDays,
    },
  });

  return { created, updated, lapsed, alerts: alertCount, detected: results };
}

export function refreshAlerts(db: DatabaseSync, today = todayIso()): number {
  const settings = allSettings(db);
  const subscriptions = listSubscriptions(db);
  const drafts = buildAlerts(subscriptions, {
    today,
    leadDays: settings.alertLeadDays,
    zombieAfterDays: settings.zombieAfterDays,
  });
  const now = new Date().toISOString();
  const keep = new Set<string>();
  const insert = db.prepare(
    "INSERT INTO alerts (id, subscription_id, kind, severity, title, body, due_at, status, snoozed_until, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?) ON CONFLICT(dedupe_key) DO UPDATE SET title = excluded.title, body = excluded.body, severity = excluded.severity, due_at = excluded.due_at, subscription_id = excluded.subscription_id",
  );
  for (const draft of drafts) {
    keep.add(draft.dedupeKey);
    insert.run(
      `alert_${sha256(draft.dedupeKey).slice(0, 16)}`,
      draft.subscriptionId,
      draft.kind,
      draft.severity,
      draft.title,
      draft.body,
      draft.dueAt,
      draft.dedupeKey,
      now,
    );
  }
  const open = db.prepare("SELECT id, dedupe_key, status FROM alerts WHERE status IN ('open', 'read')").all() as Array<{
    id: string;
    dedupe_key: string;
  }>;
  for (const alert of open) {
    if (!keep.has(alert.dedupe_key)) {
      db.prepare("UPDATE alerts SET status = 'resolved' WHERE id = ?").run(alert.id);
    }
  }
  return drafts.length;
}

import type { DatabaseSync } from "node:sqlite";
import { annualizedCents, monthlyEquivalentCents } from "../shared/detect.ts";
import { potentialSavingsCents } from "../shared/alerts.ts";
import { todayIso } from "../shared/dates.ts";
import type {
  Account,
  AiEgressEntry,
  Alert,
  AlertKind,
  AlertSeverity,
  AuditEntry,
  Cancellation,
  CancellationStep,
  DashboardStats,
  DetectionReason,
  Subscription,
  SubscriptionStatus,
  Transaction,
} from "../shared/types.ts";

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function listAccounts(db: DatabaseSync): Account[] {
  const rows = db.prepare("SELECT id, name, institution, mask, currency FROM accounts ORDER BY name").all() as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    institution: String(row.institution),
    mask: String(row.mask),
    currency: String(row.currency) as Account["currency"],
  }));
}

export function listTransactions(db: DatabaseSync): Transaction[] {
  const rows = db
    .prepare(
      "SELECT id, account_id, posted_at, amount_cents, currency, raw_descriptor, merchant_key, merchant_name, category, is_pending, source, external_id FROM transactions ORDER BY posted_at DESC",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    accountId: String(row.account_id),
    postedAt: String(row.posted_at),
    amountCents: Number(row.amount_cents),
    currency: String(row.currency) as Transaction["currency"],
    rawDescriptor: String(row.raw_descriptor),
    merchantKey: String(row.merchant_key),
    merchantName: String(row.merchant_name),
    category: String(row.category),
    isPending: Number(row.is_pending) === 1,
    source: String(row.source) as Transaction["source"],
    externalId: row.external_id === null ? null : String(row.external_id),
  }));
}

export function getTransactionsByIds(db: DatabaseSync, ids: string[]): Transaction[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, account_id, posted_at, amount_cents, currency, raw_descriptor, merchant_key, merchant_name, category, is_pending, source, external_id FROM transactions WHERE id IN (${placeholders}) ORDER BY posted_at ASC`,
    )
    .all(...ids) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    accountId: String(row.account_id),
    postedAt: String(row.posted_at),
    amountCents: Number(row.amount_cents),
    currency: String(row.currency) as Transaction["currency"],
    rawDescriptor: String(row.raw_descriptor),
    merchantKey: String(row.merchant_key),
    merchantName: String(row.merchant_name),
    category: String(row.category),
    isPending: Number(row.is_pending) === 1,
    source: String(row.source) as Transaction["source"],
    externalId: row.external_id === null ? null : String(row.external_id),
  }));
}

function mapSubscription(row: Record<string, unknown>): Subscription {
  return {
    id: String(row.id),
    merchantKey: String(row.merchant_key),
    displayName: String(row.display_name),
    category: String(row.category),
    currency: String(row.currency) as Subscription["currency"],
    amountCents: Number(row.amount_cents),
    medianAmountCents: Number(row.median_amount_cents),
    cadence: String(row.cadence) as Subscription["cadence"],
    intervalDays: row.interval_days === null ? null : Number(row.interval_days),
    billingModel: String(row.billing_model) as Subscription["billingModel"],
    confidence: Number(row.confidence),
    status: String(row.status) as SubscriptionStatus,
    firstSeen: String(row.first_seen),
    lastSeen: String(row.last_seen),
    nextChargeAt: row.next_charge_at === null ? null : String(row.next_charge_at),
    occurrences: Number(row.occurrences),
    priceChange: parseJson(row.price_change_json as string | null, null),
    cancellationChannel: String(row.cancellation_channel) as Subscription["cancellationChannel"],
    cancellationUrl: row.cancellation_url === null ? null : String(row.cancellation_url),
    tosNote: row.tos_note === null ? null : String(row.tos_note),
    noticePeriodDays: Number(row.notice_period_days),
    earlyTerminationFeeCents: Number(row.early_termination_fee_cents),
    reasons: parseJson<DetectionReason[]>(row.reasons_json as string | null, []),
    alternatives: parseJson<Subscription["alternatives"]>(row.alternatives_json as string | null, []),
    evidenceIds: parseJson<string[]>(row.evidence_json as string | null, []),
    needsReview: Number(row.needs_review) === 1,
    userRenamed: Number(row.user_renamed) === 1,
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listSubscriptions(db: DatabaseSync): Subscription[] {
  return (db.prepare("SELECT * FROM subscriptions").all() as Array<Record<string, unknown>>).map(mapSubscription);
}

export function getSubscription(db: DatabaseSync, id: string): Subscription | null {
  const row = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapSubscription(row) : null;
}

export function listAlerts(db: DatabaseSync): Alert[] {
  const rows = db
    .prepare(
      "SELECT a.*, s.display_name AS subscription_name FROM alerts a LEFT JOIN subscriptions s ON s.id = a.subscription_id ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.due_at IS NULL, a.due_at ASC",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    subscriptionId: row.subscription_id === null ? null : String(row.subscription_id),
    kind: String(row.kind) as AlertKind,
    severity: String(row.severity) as AlertSeverity,
    title: String(row.title),
    body: String(row.body),
    dueAt: row.due_at === null ? null : String(row.due_at),
    status: String(row.status) as Alert["status"],
    snoozedUntil: row.snoozed_until === null ? null : String(row.snoozed_until),
    createdAt: String(row.created_at),
    subscriptionName: row.subscription_name === null ? undefined : String(row.subscription_name),
  }));
}

export function getAlert(db: DatabaseSync, id: string): Alert | null {
  return listAlerts(db).find((alert) => alert.id === id) ?? null;
}

function mapCancellation(row: Record<string, unknown>): Cancellation {
  return {
    id: String(row.id),
    subscriptionId: String(row.subscription_id),
    subscriptionName: String(row.subscription_name ?? ""),
    state: String(row.state) as Cancellation["state"],
    mode: String(row.mode) as Cancellation["mode"],
    channel: String(row.channel) as Cancellation["channel"],
    steps: parseJson<CancellationStep[]>(row.steps_json as string | null, []),
    consequences: parseJson<string[]>(row.consequences_json as string | null, []),
    acknowledgements: parseJson(row.acknowledgements_json as string | null, {
      consequences: false,
      terms: false,
      scope: false,
    }),
    effectiveDate: row.effective_date === null ? null : String(row.effective_date),
    refundEstimateCents: Number(row.refund_estimate_cents),
    authorizationId: row.authorization_id === null ? null : String(row.authorization_id),
    tokenExpiresAt: row.token_expires_at === null || row.token_expires_at === undefined ? null : String(row.token_expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}

const CANCELLATION_SELECT = `SELECT c.*, s.display_name AS subscription_name, a.expires_at AS token_expires_at
  FROM cancellations c
  JOIN subscriptions s ON s.id = c.subscription_id
  LEFT JOIN authorizations a ON a.id = c.authorization_id`;

export function listCancellations(db: DatabaseSync): Cancellation[] {
  return (db.prepare(`${CANCELLATION_SELECT} ORDER BY c.created_at DESC`).all() as Array<Record<string, unknown>>).map(
    mapCancellation,
  );
}

export function getCancellation(db: DatabaseSync, id: string): Cancellation | null {
  const row = db.prepare(`${CANCELLATION_SELECT} WHERE c.id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapCancellation(row) : null;
}

export function listAudit(db: DatabaseSync, limit = 200): AuditEntry[] {
  const rows = db
    .prepare("SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    seq: Number(row.seq),
    at: String(row.at),
    actor: String(row.actor) as AuditEntry["actor"],
    action: String(row.action),
    subject: String(row.subject),
    detail: parseJson<Record<string, unknown>>(row.detail_json as string | null, {}),
    prevHash: String(row.prev_hash),
    hash: String(row.hash),
  }));
}

export function listAiEvents(db: DatabaseSync, limit = 100): AiEgressEntry[] {
  const rows = db
    .prepare("SELECT * FROM ai_events ORDER BY at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    at: String(row.at),
    task: String(row.task),
    model: String(row.model),
    provider: String(row.provider),
    ok: Number(row.ok) === 1,
    latencyMs: Number(row.latency_ms),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    payload: parseJson<Record<string, unknown>>(row.payload_json as string | null, {}),
    summary: String(row.summary),
  }));
}

export function getStats(db: DatabaseSync, today = todayIso()): DashboardStats {
  const subscriptions = listSubscriptions(db);
  const active = subscriptions.filter((sub) => sub.status === "active" || sub.status === "pending_review");
  const monthly = active.reduce((sum, sub) => sum + monthlyEquivalentCents(sub.amountCents, sub.cadence), 0);
  const annual = active.reduce((sum, sub) => sum + annualizedCents(sub.amountCents, sub.cadence), 0);
  const next30 = active
    .filter((sub) => sub.nextChargeAt && sub.nextChargeAt >= today && sub.nextChargeAt <= addDaysIso(today, 30))
    .reduce((sum, sub) => sum + sub.amountCents, 0);
  const confidenceSum = active.reduce((sum, sub) => sum + sub.confidence, 0);
  return {
    monthlyRecurringCents: monthly,
    annualRecurringCents: annual,
    activeCount: active.length,
    pendingReviewCount: subscriptions.filter((sub) => sub.status === "pending_review").length,
    cancelledCount: subscriptions.filter((sub) => sub.status === "cancelled").length,
    potentialSavingsCents: potentialSavingsCents(subscriptions, today),
    next30DaysCents: next30,
    avgConfidence: active.length === 0 ? 0 : Number((confidenceSum / active.length).toFixed(3)),
    lastDetectedAt: (db.prepare("SELECT value FROM meta WHERE key = 'last_detected_at'").get() as { value: string } | undefined)
      ?.value ?? null,
  };
}

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function countTransactions(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
  return Number(row.n);
}

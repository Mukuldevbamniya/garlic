/**
 * Shared domain vocabulary. The server owns the database; the browser only ever
 * sees these shapes. Money is always integer minor units (cents) so we never do
 * floating point arithmetic on balances.
 */

export const CURRENCIES = ["USD", "EUR", "GBP", "INR"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const CADENCES = [
  "weekly",
  "biweekly",
  "four_weekly",
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
  "custom",
] as const;
export type Cadence = (typeof CADENCES)[number];

export const SUBSCRIPTION_STATUSES = [
  "active",
  "pending_review",
  "cancelled",
  "lapsed",
  "ignored",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const CANCELLATION_CHANNELS = [
  "provider_api",
  "web_form",
  "email",
  "phone",
  "app_store",
  "unknown",
] as const;
export type CancellationChannel = (typeof CANCELLATION_CHANNELS)[number];

export type BillingModel = "fixed" | "variable";

export interface Account {
  id: string;
  name: string;
  institution: string;
  mask: string;
  currency: Currency;
}

export interface Transaction {
  id: string;
  accountId: string;
  postedAt: string; // YYYY-MM-DD
  amountCents: number; // positive = charge, negative = refund
  currency: Currency;
  rawDescriptor: string;
  merchantKey: string;
  merchantName: string;
  category: string;
  isPending: boolean;
  source: "demo" | "csv" | "manual";
  externalId: string | null;
}

export interface DetectionReason {
  code: string;
  label: string;
  detail: string;
  weight: number; // signed contribution to confidence
}

export interface PriceChange {
  fromCents: number;
  toCents: number;
  at: string;
  deltaPct: number;
}

export interface Subscription {
  id: string;
  merchantKey: string;
  displayName: string;
  category: string;
  currency: Currency;
  amountCents: number;
  medianAmountCents: number;
  cadence: Cadence;
  intervalDays: number | null;
  billingModel: BillingModel;
  confidence: number;
  status: SubscriptionStatus;
  firstSeen: string;
  lastSeen: string;
  nextChargeAt: string | null;
  occurrences: number;
  priceChange: PriceChange | null;
  cancellationChannel: CancellationChannel;
  cancellationUrl: string | null;
  tosNote: string | null;
  noticePeriodDays: number;
  earlyTerminationFeeCents: number;
  reasons: DetectionReason[];
  alternatives: Array<{ cadence: Cadence; confidence: number }>;
  evidenceIds: string[];
  needsReview: boolean;
  userRenamed: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const ALERT_KINDS = [
  "renewal",
  "price_increase",
  "trial_ending",
  "annual_renewal",
  "duplicate_service",
  "failed_charge",
  "zombie",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  id: string;
  subscriptionId: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  dueAt: string | null;
  status: "open" | "read" | "snoozed" | "resolved";
  snoozedUntil: string | null;
  createdAt: string;
  subscriptionName?: string;
}

export const CANCELLATION_STATES = [
  "draft",
  "awaiting_authorization",
  "authorized",
  "executing",
  "verifying",
  "cancelled",
  "requires_human",
  "failed",
  "revoked",
] as const;
export type CancellationState = (typeof CANCELLATION_STATES)[number];

export interface CancellationStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "skipped" | "blocked" | "failed";
  detail: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Cancellation {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  state: CancellationState;
  mode: "dry_run" | "live";
  channel: CancellationChannel;
  steps: CancellationStep[];
  consequences: string[];
  acknowledgements: {
    consequences: boolean;
    terms: boolean;
    scope: boolean;
  };
  effectiveDate: string | null;
  refundEstimateCents: number;
  authorizationId: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AuditEntry {
  id: string;
  seq: number;
  at: string;
  actor: "user" | "system" | "agent" | "ai";
  action: string;
  subject: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AiEgressEntry {
  id: string;
  at: string;
  task: string;
  model: string;
  provider: string;
  ok: boolean;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Exactly what left the device. Never contains raw descriptors or account numbers. */
  payload: Record<string, unknown>;
  summary: string;
}

export interface MerchantProfile {
  merchantKey: string;
  displayName: string;
  category: string;
  cancellationChannel: CancellationChannel;
  cancellationUrl: string | null;
  tosNote: string | null;
  noticePeriodDays: number;
  earlyTerminationFeeCents: number;
  isKnownSubscription: boolean;
  source: "catalog" | "ai" | "user";
}

export interface AppSettings {
  currency: Currency;
  alertLeadDays: number;
  aiEnabled: boolean;
  dryRunOnly: boolean;
  zombieAfterDays: number;
}

export interface AiStatus {
  enabled: boolean;
  configured: boolean;
  provider: string | null;
  model: string | null;
  reason: string | null;
}

export interface AppState {
  accounts: Account[];
  settings: AppSettings;
  ai: AiStatus;
  stats: DashboardStats;
  counts: {
    transactions: number;
    subscriptions: number;
    openAlerts: number;
  };
  lastDetectedAt: string | null;
}

export interface DashboardStats {
  monthlyRecurringCents: number;
  annualRecurringCents: number;
  activeCount: number;
  pendingReviewCount: number;
  cancelledCount: number;
  potentialSavingsCents: number;
  next30DaysCents: number;
  avgConfidence: number;
  lastDetectedAt: string | null;
}

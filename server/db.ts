import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  institution TEXT NOT NULL,
  mask TEXT NOT NULL,
  currency TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  posted_at TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  raw_descriptor TEXT NOT NULL,
  merchant_key TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  category TEXT NOT NULL,
  is_pending INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  external_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_merchant ON transactions(merchant_key, posted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_external ON transactions(account_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  merchant_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  median_amount_cents INTEGER NOT NULL,
  cadence TEXT NOT NULL,
  interval_days INTEGER,
  billing_model TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  next_charge_at TEXT,
  occurrences INTEGER NOT NULL,
  price_change_json TEXT,
  cancellation_channel TEXT NOT NULL,
  cancellation_url TEXT,
  tos_note TEXT,
  notice_period_days INTEGER NOT NULL DEFAULT 0,
  early_termination_fee_cents INTEGER NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL,
  alternatives_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  user_renamed INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_status ON subscriptions(status);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  subscription_id TEXT REFERENCES subscriptions(id),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  snoozed_until TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cancellations (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  state TEXT NOT NULL,
  mode TEXT NOT NULL,
  channel TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  consequences_json TEXT NOT NULL,
  acknowledgements_json TEXT NOT NULL,
  effective_date TEXT,
  refund_estimate_cents INTEGER NOT NULL DEFAULT 0,
  authorization_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS authorizations (
  id TEXT PRIMARY KEY,
  cancellation_id TEXT NOT NULL REFERENCES cancellations(id),
  scope_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  ok INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  payload_json TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchant_profiles (
  merchant_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  cancellation_channel TEXT NOT NULL,
  cancellation_url TEXT,
  tos_note TEXT,
  notice_period_days INTEGER NOT NULL DEFAULT 0,
  early_termination_fee_cents INTEGER NOT NULL DEFAULT 0,
  is_known_subscription INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  currency: "USD",
  alertLeadDays: 3,
  aiEnabled: true,
  dryRunOnly: false,
  zombieAfterDays: 60,
} as const;

export function openDatabase(file?: string): DatabaseSync {
  const path = file ?? process.env.GARLIC_DB ?? join(process.cwd(), "data", "garlic.db");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function getSetting<T>(db: DatabaseSync, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    JSON.stringify(value),
  );
}

export function allSettings(db: DatabaseSync) {
  return {
    currency: getSetting(db, "currency", DEFAULT_SETTINGS.currency),
    alertLeadDays: getSetting(db, "alertLeadDays", DEFAULT_SETTINGS.alertLeadDays),
    aiEnabled: getSetting(db, "aiEnabled", DEFAULT_SETTINGS.aiEnabled),
    dryRunOnly: getSetting(db, "dryRunOnly", DEFAULT_SETTINGS.dryRunOnly),
    zombieAfterDays: getSetting(db, "zombieAfterDays", DEFAULT_SETTINGS.zombieAfterDays),
  };
}

export interface AuditInput {
  actor: "user" | "system" | "agent" | "ai";
  action: string;
  subject: string;
  detail?: Record<string, unknown>;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Append-only, hash-chained audit trail. Each entry commits to the previous
 * hash, so deleting or editing history breaks verification.
 */
export function appendAudit(db: DatabaseSync, input: AuditInput): { id: string; seq: number; hash: string } {
  const last = db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as
    | { seq: number; hash: string }
    | undefined;
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? "0".repeat(64);
  const at = new Date().toISOString();
  const detail = input.detail ?? {};
  const hash = sha256(
    JSON.stringify({ seq, at, actor: input.actor, action: input.action, subject: input.subject, detail, prevHash }),
  );
  const id = randomUUID();
  db.prepare(
    "INSERT INTO audit_log (id, seq, at, actor, action, subject, detail_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, seq, at, input.actor, input.action, input.subject, JSON.stringify(detail), prevHash, hash);
  return { id, seq, hash };
}

export function verifyAuditChain(db: DatabaseSync): { ok: boolean; brokenAt: number | null; entries: number } {
  const rows = db
    .prepare("SELECT seq, at, actor, action, subject, detail_json, prev_hash, hash FROM audit_log ORDER BY seq ASC")
    .all() as Array<{
    seq: number;
    at: string;
    actor: string;
    action: string;
    subject: string;
    detail_json: string;
    prev_hash: string;
    hash: string;
  }>;
  let prevHash = "0".repeat(64);
  for (const row of rows) {
    const expected = sha256(
      JSON.stringify({
        seq: row.seq,
        at: row.at,
        actor: row.actor,
        action: row.action,
        subject: row.subject,
        detail: JSON.parse(row.detail_json),
        prevHash,
      }),
    );
    if (row.prev_hash !== prevHash || row.hash !== expected) {
      return { ok: false, brokenAt: row.seq, entries: rows.length };
    }
    prevHash = row.hash;
  }
  return { ok: true, brokenAt: null, entries: rows.length };
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

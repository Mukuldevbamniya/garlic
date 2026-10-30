import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AUTHORIZATION_TTL_MS,
  buildCancellationPlan,
  canonicalScope,
  expectedConfirmation,
  isTokenExpired,
  validateAuthorization,
} from "../shared/cancellation.ts";
import { parseCsv } from "../shared/csv.ts";
import { normalizeMerchantKey, catalogProfile } from "../shared/catalog.ts";
import { addDays, todayIso } from "../shared/dates.ts";
import {
  allSettings,
  appendAudit,
  getMeta,
  setSetting,
  sha256,
} from "./db.ts";
import { refreshAlerts, runDetection } from "./detect-service.ts";
import { executeCancellation } from "./agent.ts";
import {
  aiStatus,
  cancellationBrief,
  enrichMerchant,
  localAnswer,
  logEgress,
  redactDescriptor,
  reviewDetection,
  streamConcierge,
} from "./ai.ts";
import {
  countTransactions,
  getAlert,
  getCancellation,
  getSubscription,
  getStats,
  getTransactionsByIds,
  listAccounts,
  listAlerts,
  listCancellations,
  listSubscriptions,
  listTransactions,
} from "./store.ts";

const json = (value: unknown) => JSON.stringify(value);

function fail(status: 400 | 401 | 403 | 404 | 409 | 422 | 500, message: string) {
  return { error: message, status } as const;
}

async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, message: "Request body must be valid JSON." };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      message: first ? `${first.path.join(".") || "body"}: ${first.message}` : "Request body is invalid.",
    };
  }
  return { ok: true, data: parsed.data };
}

const EnrichSchema = z.object({ subscriptionId: z.string().min(1) });
const ReviewSchema = z.object({ subscriptionId: z.string().min(1) });
const BriefSchema = z.object({ subscriptionId: z.string().min(1) });
const ChatSchema = z.object({ messages: z.array(z.unknown()) });
const AskSchema = z.object({ question: z.string().min(1).max(500) });

const CreateCancellationSchema = z.object({
  subscriptionId: z.string().min(1),
  mode: z.enum(["dry_run", "live"]).default("dry_run"),
});

const AuthorizeSchema = z.object({
  acknowledgements: z.object({
    consequences: z.boolean(),
    terms: z.boolean(),
    scope: z.boolean(),
  }),
  confirmation: z.string().min(1).max(120),
});

const ExecuteSchema = z.object({ token: z.string().min(10).max(200) });
const AttestSchema = z.object({ reference: z.string().min(1).max(120).optional() });
const ImportSchema = z.object({ csv: z.string().min(1).max(2_000_000), accountId: z.string().optional() });
const SnoozeSchema = z.object({ days: z.number().int().min(1).max(60).default(3) });
const ClearSchema = z.object({ confirmation: z.literal("CLEAR LEDGER") });
const SettingsSchema = z.object({
  currency: z.enum(["USD", "EUR", "GBP", "INR"]).optional(),
  alertLeadDays: z.number().int().min(0).max(30).optional(),
  aiEnabled: z.boolean().optional(),
  dryRunOnly: z.boolean().optional(),
  zombieAfterDays: z.number().int().min(30).max(365).optional(),
});
const UpdateSubscriptionSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  status: z.enum(["active", "pending_review", "cancelled", "lapsed", "ignored"]).optional(),
  lastUsedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

function state(db: DatabaseSync) {
  const settings = allSettings(db);
  const subscriptions = listSubscriptions(db);
  return {
    accounts: listAccounts(db),
    settings,
    ai: aiStatus(settings.aiEnabled),
    stats: getStats(db),
    counts: {
      transactions: countTransactions(db),
      subscriptions: subscriptions.length,
      openAlerts: listAlerts(db).filter((alert) => alert.status === "open" || alert.status === "read").length,
    },
    lastDetectedAt: getMeta(db, "last_detected_at"),
  };
}

export function createApp(db: DatabaseSync): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, at: new Date().toISOString() }));

  app.get("/api/state", (c) => c.json(state(db)));

  app.get("/api/subscriptions", (c) => {
    const status = c.req.query("status");
    const subscriptions = listSubscriptions(db);
    const filtered = status ? subscriptions.filter((sub) => sub.status === status) : subscriptions;
    return c.json({ subscriptions: filtered });
  });

  app.get("/api/subscriptions/:id", (c) => {
    const sub = getSubscription(db, c.req.param("id"));
    if (!sub) return c.json(fail(404, "Subscription not found."), 404);
    return c.json({
      subscription: sub,
      evidence: getTransactionsByIds(db, sub.evidenceIds),
      alerts: listAlerts(db).filter((alert) => alert.subscriptionId === sub.id),
      cancellations: listCancellations(db).filter((item) => item.subscriptionId === sub.id),
    });
  });

  app.patch("/api/subscriptions/:id", async (c) => {
    const sub = getSubscription(db, c.req.param("id"));
    if (!sub) return c.json(fail(404, "Subscription not found."), 404);
    const parsed = await readBody(c.req.raw, UpdateSubscriptionSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);

    const now = new Date().toISOString();
    if (parsed.data.displayName !== undefined) {
      db.prepare("UPDATE subscriptions SET display_name = ?, user_renamed = 1, updated_at = ? WHERE id = ?").run(
        parsed.data.displayName,
        now,
        sub.id,
      );
    }
    if (parsed.data.status !== undefined) {
      db.prepare("UPDATE subscriptions SET status = ?, next_charge_at = CASE WHEN ? = 'cancelled' THEN NULL ELSE next_charge_at END, updated_at = ? WHERE id = ?").run(
        parsed.data.status,
        parsed.data.status,
        now,
        sub.id,
      );
    }
    if (parsed.data.lastUsedAt !== undefined) {
      db.prepare("UPDATE subscriptions SET last_used_at = ?, updated_at = ? WHERE id = ?").run(
        parsed.data.lastUsedAt,
        now,
        sub.id,
      );
    }
    appendAudit(db, {
      actor: "user",
      action: "subscription.updated",
      subject: sub.id,
      detail: { merchant: sub.displayName, changes: parsed.data },
    });
    refreshAlerts(db);
    return c.json({ subscription: getSubscription(db, sub.id) });
  });

  app.post("/api/subscriptions/:id/confirm", (c) => {
    const sub = getSubscription(db, c.req.param("id"));
    if (!sub) return c.json(fail(404, "Subscription not found."), 404);
    db.prepare("UPDATE subscriptions SET status = 'active', needs_review = 0, updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      sub.id,
    );
    appendAudit(db, {
      actor: "user",
      action: "subscription.confirmed",
      subject: sub.id,
      detail: { merchant: sub.displayName, confidence: sub.confidence },
    });
    refreshAlerts(db);
    return c.json({ subscription: getSubscription(db, sub.id) });
  });

  app.post("/api/subscriptions/:id/dismiss", (c) => {
    const sub = getSubscription(db, c.req.param("id"));
    if (!sub) return c.json(fail(404, "Subscription not found."), 404);
    db.prepare("UPDATE subscriptions SET status = 'ignored', next_charge_at = NULL, updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      sub.id,
    );
    appendAudit(db, {
      actor: "user",
      action: "subscription.dismissed",
      subject: sub.id,
      detail: { merchant: sub.displayName, note: "User marked this as not a subscription." },
    });
    refreshAlerts(db);
    return c.json({ subscription: getSubscription(db, sub.id) });
  });

  app.get("/api/alerts", (c) => c.json({ alerts: listAlerts(db) }));

  app.post("/api/alerts/:id/read", (c) => {
    const alert = getAlert(db, c.req.param("id"));
    if (!alert) return c.json(fail(404, "Alert not found."), 404);
    db.prepare("UPDATE alerts SET status = CASE WHEN status = 'open' THEN 'read' ELSE status END WHERE id = ?").run(alert.id);
    return c.json({ alert: getAlert(db, alert.id) });
  });

  app.post("/api/alerts/:id/snooze", async (c) => {
    const alert = getAlert(db, c.req.param("id"));
    if (!alert) return c.json(fail(404, "Alert not found."), 404);
    const parsed = await readBody(c.req.raw, SnoozeSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    const until = addDays(todayIso(), parsed.data.days);
    db.prepare("UPDATE alerts SET status = 'snoozed', snoozed_until = ? WHERE id = ?").run(until, alert.id);
    appendAudit(db, {
      actor: "user",
      action: "alert.snoozed",
      subject: alert.id,
      detail: { until, title: alert.title },
    });
    return c.json({ alert: getAlert(db, alert.id) });
  });

  app.post("/api/alerts/:id/resolve", (c) => {
    const alert = getAlert(db, c.req.param("id"));
    if (!alert) return c.json(fail(404, "Alert not found."), 404);
    db.prepare("UPDATE alerts SET status = 'resolved' WHERE id = ?").run(alert.id);
    return c.json({ alert: getAlert(db, alert.id) });
  });

  app.post("/api/detect", (c) => {
    const summary = runDetection(db);
    return c.json({
      summary: {
        created: summary.created,
        updated: summary.updated,
        lapsed: summary.lapsed,
        alerts: summary.alerts,
      },
      stats: getStats(db),
    });
  });

  app.post("/api/import/preview", async (c) => {
    const parsed = await readBody(c.req.raw, ImportSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    const result = parseCsv(parsed.data.csv);
    const existing = new Set(
      listTransactions(db).map((row) => sha256(`${row.postedAt}|${row.rawDescriptor}|${row.amountCents}`)),
    );
    const rows = result.rows.slice(0, 500).map((row) => ({
      ...row,
      merchantKey: normalizeMerchantKey(row.descriptor),
      merchantName: catalogProfile(row.descriptor, normalizeMerchantKey(row.descriptor)).displayName,
      duplicate: existing.has(sha256(`${row.postedAt}|${row.descriptor}|${row.amountCents}`)),
    }));
    return c.json({
      rows,
      errors: result.errors,
      detectedColumns: result.detectedColumns,
      signConvention: result.signConvention,
      totals: {
        parsed: result.rows.length,
        duplicates: rows.filter((row) => row.duplicate).length,
        skipped: result.rows.length - rows.length,
        firstDate: result.rows[0]?.postedAt ?? null,
        lastDate: result.rows[result.rows.length - 1]?.postedAt ?? null,
      },
    });
  });

  app.post("/api/import/commit", async (c) => {
    const parsed = await readBody(c.req.raw, ImportSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    const result = parseCsv(parsed.data.csv);
    if (result.rows.length === 0) {
      return c.json(fail(422, result.errors[0]?.message ?? "No usable rows found in that file."), 422);
    }
    const accounts = listAccounts(db);
    const accountId = parsed.data.accountId ?? accounts[0]?.id ?? "acct-imported";
    if (!accounts.some((account) => account.id === accountId)) {
      db.prepare("INSERT INTO accounts (id, name, institution, mask, currency) VALUES (?, ?, ?, ?, ?)").run(
        accountId,
        "Imported statement",
        "CSV",
        "0000",
        "USD",
      );
    }
    const insert = db.prepare(
      "INSERT OR IGNORE INTO transactions (id, account_id, posted_at, amount_cents, currency, raw_descriptor, merchant_key, merchant_name, category, is_pending, source, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'csv', ?, ?)",
    );
    let inserted = 0;
    for (const row of result.rows) {
      const merchantKey = normalizeMerchantKey(row.descriptor);
      const profile = catalogProfile(row.descriptor, merchantKey);
      const externalId = `csv-${sha256(`${row.postedAt}|${row.descriptor}|${row.amountCents}`).slice(0, 20)}`;
      const info = insert.run(
        randomUUID(),
        accountId,
        row.postedAt,
        row.amountCents,
        "USD",
        row.descriptor,
        merchantKey,
        profile.displayName,
        profile.category,
        externalId,
        new Date().toISOString(),
      );
      inserted += Number(info.changes);
    }
    const summary = runDetection(db);
    appendAudit(db, {
      actor: "user",
      action: "transactions.imported",
      subject: accountId,
      detail: {
        parsed: result.rows.length,
        inserted,
        skipped: result.rows.length - inserted,
        detected: summary.detected.length,
        firstDate: result.rows[0]?.postedAt ?? null,
        lastDate: result.rows[result.rows.length - 1]?.postedAt ?? null,
      },
    });
    return c.json({
      inserted,
      skipped: result.rows.length - inserted,
      errors: result.errors.slice(0, 20),
      stats: getStats(db),
    });
  });

  app.get("/api/cancellations", (c) => c.json({ cancellations: listCancellations(db) }));

  app.get("/api/cancellations/:id", (c) => {
    const cancellation = getCancellation(db, c.req.param("id"));
    if (!cancellation) return c.json(fail(404, "Cancellation not found."), 404);
    return c.json({ cancellation });
  });

  app.post("/api/cancellations", async (c) => {
    const parsed = await readBody(c.req.raw, CreateCancellationSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    const sub = getSubscription(db, parsed.data.subscriptionId);
    if (!sub) return c.json(fail(404, "Subscription not found."), 404);
    if (sub.status === "cancelled" || sub.status === "ignored") {
      return c.json(fail(409, `${sub.displayName} is already ${sub.status}. Nothing to cancel.`), 409);
    }
    const settings = allSettings(db);
    if (parsed.data.mode === "live" && settings.dryRunOnly) {
      return c.json(
        fail(403, "Live mode is off. Turn off Rehearsal only in Settings to mark a subscription cancelled."),
        403,
      );
    }
    const plan = buildCancellationPlan(sub, parsed.data.mode);
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO cancellations (id, subscription_id, state, mode, channel, steps_json, consequences_json, acknowledgements_json, effective_date, refund_estimate_cents, authorization_id, created_at, updated_at, completed_at) VALUES (?, ?, 'awaiting_authorization', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)",
    ).run(
      id,
      sub.id,
      parsed.data.mode,
      plan.channel,
      json(plan.steps),
      json(plan.consequences),
      json({ consequences: false, terms: false, scope: false }),
      plan.effectiveDate,
      plan.refundEstimateCents,
      now,
      now,
    );
    appendAudit(db, {
      actor: "user",
      action: "cancellation.prepared",
      subject: sub.id,
      detail: {
        cancellationId: id,
        merchant: sub.displayName,
        mode: parsed.data.mode,
        channel: plan.channel,
        effectiveDate: plan.effectiveDate,
        refundEstimateCents: plan.refundEstimateCents,
        requiresHuman: plan.requiresHuman,
      },
    });
    return c.json({ cancellation: getCancellation(db, id) }, 201);
  });

  app.post("/api/cancellations/:id/authorize", async (c) => {
    const cancellation = getCancellation(db, c.req.param("id"));
    if (!cancellation) return c.json(fail(404, "Cancellation not found."), 404);
    if (cancellation.state !== "awaiting_authorization") {
      return c.json(fail(409, `This cancellation is ${cancellation.state.replaceAll("_", " ")}, not awaiting authorization.`), 409);
    }
    const sub = getSubscription(db, cancellation.subscriptionId);
    if (!sub) return c.json(fail(404, "Subscription not found."), 404);
    const parsed = await readBody(c.req.raw, AuthorizeSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);

    const settings = allSettings(db);
    if (cancellation.mode === "live" && settings.dryRunOnly) {
      return c.json(fail(403, "Live mode is disabled in settings. Nothing was authorized."), 403);
    }

    const validation = validateAuthorization(sub, parsed.data);
    if (!validation.ok) {
      const messages: Record<string, string> = {
        not_all_acknowledged: "All three acknowledgements are required before the agent may act.",
        confirmation_mismatch: `Type exactly: ${expectedConfirmation(sub)}`,
        nothing_to_cancel: "This subscription is already cancelled or dismissed.",
      };
      appendAudit(db, {
        actor: "user",
        action: "cancellation.authorization_rejected",
        subject: sub.id,
        detail: { cancellationId: cancellation.id, reason: validation.problem },
      });
      return c.json(fail(422, messages[validation.problem] ?? "Authorization rejected."), 422);
    }

    const scope = {
      cancellationId: cancellation.id,
      subscriptionId: sub.id,
      merchant: sub.displayName,
      amountCents: sub.amountCents,
      cadence: sub.cadence,
      channel: sub.cancellationChannel,
      mode: cancellation.mode,
      effectiveDate: cancellation.effectiveDate ?? todayIso(),
      earlyTerminationFeeCents: sub.earlyTerminationFeeCents,
    };
    const token = randomBytes(24).toString("base64url");
    const authorizationId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + AUTHORIZATION_TTL_MS);
    db.prepare(
      "INSERT INTO authorizations (id, cancellation_id, scope_json, scope_hash, token_hash, issued_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    ).run(
      authorizationId,
      cancellation.id,
      json(scope),
      sha256(canonicalScope(scope)),
      sha256(token),
      issuedAt.toISOString(),
      expiresAt.toISOString(),
    );
    db.prepare(
      "UPDATE cancellations SET state = 'authorized', authorization_id = ?, acknowledgements_json = ?, updated_at = ? WHERE id = ?",
    ).run(authorizationId, json(parsed.data.acknowledgements), issuedAt.toISOString(), cancellation.id);
    appendAudit(db, {
      actor: "user",
      action: "cancellation.authorized",
      subject: sub.id,
      detail: {
        cancellationId: cancellation.id,
        authorizationId,
        scopeHash: sha256(canonicalScope(scope)).slice(0, 16),
        expiresAt: expiresAt.toISOString(),
        acknowledgements: parsed.data.acknowledgements,
        mode: cancellation.mode,
      },
    });
    return c.json({
      cancellation: getCancellation(db, cancellation.id),
      token,
      expiresAt: expiresAt.toISOString(),
      scope,
    });
  });

  app.post("/api/cancellations/:id/execute", async (c) => {
    const cancellation = getCancellation(db, c.req.param("id"));
    if (!cancellation) return c.json(fail(404, "Cancellation not found."), 404);
    if (cancellation.state !== "authorized") {
      return c.json(fail(409, `This cancellation is ${cancellation.state.replaceAll("_", " ")}, not authorized.`), 409);
    }
    const parsed = await readBody(c.req.raw, ExecuteSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    const sub = getSubscription(db, cancellation.subscriptionId);
    if (!sub) return c.json(fail(404, "Subscription not found."), 404);

    const authorization = db
      .prepare("SELECT id, scope_hash, token_hash, expires_at, consumed_at FROM authorizations WHERE id = ?")
      .get(cancellation.authorizationId ?? "") as
      | { id: string; scope_hash: string; token_hash: string; expires_at: string; consumed_at: string | null }
      | undefined;
    if (!authorization) return c.json(fail(409, "No authorization exists for this cancellation."), 409);
    if (authorization.consumed_at) return c.json(fail(409, "That authorization was already used. Authorize a new one."), 409);
    if (isTokenExpired(authorization.expires_at)) {
      return c.json(fail(409, "The authorization expired. Re-authorize to continue — nothing was sent."), 409);
    }
    const provided = Buffer.from(sha256(parsed.data.token), "hex");
    const expected = Buffer.from(authorization.token_hash, "hex");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      appendAudit(db, {
        actor: "system",
        action: "cancellation.token_rejected",
        subject: sub.id,
        detail: { cancellationId: cancellation.id, reason: "token_mismatch" },
      });
      return c.json(fail(401, "That authorization token is not valid for this cancellation."), 401);
    }

    // Bind the token to the exact plan the user saw. If the amount or effective
    // date moved since authorization, refuse rather than act on stale consent.
    const currentScope = {
      cancellationId: cancellation.id,
      subscriptionId: sub.id,
      merchant: sub.displayName,
      amountCents: sub.amountCents,
      cadence: sub.cadence,
      channel: sub.cancellationChannel,
      mode: cancellation.mode,
      effectiveDate: cancellation.effectiveDate ?? todayIso(),
      earlyTerminationFeeCents: sub.earlyTerminationFeeCents,
    };
    if (sha256(canonicalScope(currentScope)) !== authorization.scope_hash) {
      appendAudit(db, {
        actor: "system",
        action: "cancellation.scope_changed",
        subject: sub.id,
        detail: { cancellationId: cancellation.id, reason: "scope_changed_after_authorization" },
      });
      return c.json(
        fail(409, "The plan changed after you authorized it. Nothing was sent. Review the new details and authorize again."),
        409,
      );
    }

    db.prepare("UPDATE authorizations SET consumed_at = ? WHERE id = ?").run(new Date().toISOString(), authorization.id);
    db.prepare("UPDATE cancellations SET state = 'executing', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      cancellation.id,
    );
    appendAudit(db, {
      actor: "agent",
      action: "cancellation.execution_started",
      subject: sub.id,
      detail: { cancellationId: cancellation.id, mode: cancellation.mode, transport: "sandbox" },
    });
    void executeCancellation(db, cancellation.id);
    return c.json({ accepted: true, cancellation: getCancellation(db, cancellation.id) }, 202);
  });

  app.post("/api/cancellations/:id/revoke", (c) => {
    const cancellation = getCancellation(db, c.req.param("id"));
    if (!cancellation) return c.json(fail(404, "Cancellation not found."), 404);
    if (!["draft", "awaiting_authorization", "authorized", "requires_human", "failed"].includes(cancellation.state)) {
      return c.json(fail(409, `Cannot revoke a cancellation that is ${cancellation.state.replaceAll("_", " ")}.`), 409);
    }
    db.prepare("UPDATE cancellations SET state = 'revoked', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      cancellation.id,
    );
    appendAudit(db, {
      actor: "user",
      action: "cancellation.revoked",
      subject: cancellation.subscriptionId,
      detail: { cancellationId: cancellation.id, previousState: cancellation.state },
    });
    return c.json({ cancellation: getCancellation(db, cancellation.id) });
  });

  app.post("/api/cancellations/:id/attest", async (c) => {
    const cancellation = getCancellation(db, c.req.param("id"));
    if (!cancellation) return c.json(fail(404, "Cancellation not found."), 404);
    if (cancellation.state !== "requires_human") {
      return c.json(fail(409, "Only a cancellation that needs a human step can be attested."), 409);
    }
    const parsed = await readBody(c.req.raw, AttestSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    const steps = cancellation.steps.map((step) =>
      step.status === "done"
        ? step
        : {
            ...step,
            status: "done" as const,
            startedAt: step.startedAt ?? new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            detail: `Completed by you${parsed.data.reference ? ` (ref ${parsed.data.reference})` : ""}.`,
          },
    );
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE cancellations SET state = 'cancelled', steps_json = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    ).run(json(steps), now, now, cancellation.id);
    if (cancellation.mode === "live") {
      db.prepare("UPDATE subscriptions SET status = 'cancelled', next_charge_at = NULL, updated_at = ? WHERE id = ?").run(
        now,
        cancellation.subscriptionId,
      );
    }
    appendAudit(db, {
      actor: "user",
      action: "cancellation.attested",
      subject: cancellation.subscriptionId,
      detail: { cancellationId: cancellation.id, reference: parsed.data.reference ?? null, mode: cancellation.mode },
    });
    return c.json({ cancellation: getCancellation(db, cancellation.id) });
  });

  app.post("/api/ledger/clear", async (c) => {
    const parsed = await readBody(c.req.raw, ClearSchema);
    if (!parsed.ok) {
      return c.json(fail(422, "Type CLEAR LEDGER to confirm. Nothing was deleted."), 422);
    }
    db.exec(
      "DELETE FROM authorizations; DELETE FROM cancellations; DELETE FROM alerts; DELETE FROM subscriptions; DELETE FROM transactions; DELETE FROM accounts; DELETE FROM merchant_profiles; DELETE FROM ai_events; DELETE FROM audit_log; DELETE FROM settings; DELETE FROM meta;",
    );
    return c.json({ ok: true, deleted: true });
  });

  app.patch("/api/settings", async (c) => {
    const parsed = await readBody(c.req.raw, SettingsSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) setSetting(db, key, value);
    }
    appendAudit(db, {
      actor: "user",
      action: "settings.updated",
      subject: "settings",
      detail: parsed.data,
    });
    refreshAlerts(db);
    return c.json({ settings: allSettings(db), ai: aiStatus(allSettings(db).aiEnabled) });
  });

  /* ---------------------------------- AI ---------------------------------- */

  const requireAi = (): boolean => allSettings(db).aiEnabled;

  app.get("/api/ai/status", (c) => c.json({ ai: aiStatus(allSettings(db).aiEnabled) }));

  app.post("/api/ai/enrich", async (c) => {
    if (!requireAi()) return c.json(fail(403, "AI is switched off in settings. Nothing was sent."), 403);
    const parsed = await readBody(c.req.raw, EnrichSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    const sub = getSubscription(db, parsed.data.subscriptionId);
    if (!sub) return c.json(fail(404, "Subscription not found."), 404);
    const descriptor = sub.evidenceIds.length > 0
      ? getTransactionsByIds(db, [sub.evidenceIds[sub.evidenceIds.length - 1]!])[0]?.rawDescriptor ?? sub.displayName
      : sub.displayName;
    const result = await enrichMerchant(db, {
      merchantKey: sub.merchantKey,
      descriptor,
      amountCents: sub.amountCents,
      cadence: sub.cadence,
    });
    if (result.source === "ai" && !sub.userRenamed) {
      db.prepare(
        "UPDATE subscriptions SET display_name = ?, category = ?, cancellation_channel = ?, cancellation_url = ?, tos_note = ?, updated_at = ? WHERE id = ?",
      ).run(
        result.enrichment.displayName,
        result.enrichment.category,
        result.enrichment.cancellationChannel,
        result.enrichment.cancellationUrl,
        result.enrichment.tosNote,
        new Date().toISOString(),
        sub.id,
      );
    }
    return c.json({
      ...result,
      redactedInput: redactDescriptor(descriptor),
      subscription: getSubscription(db, sub.id),
    });
  });

  app.post("/api/ai/review", async (c) => {
    if (!requireAi()) return c.json(fail(403, "AI is switched off in settings. Nothing was sent."), 403);
    const parsed = await readBody(c.req.raw, ReviewSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    const sub = getSubscription(db, parsed.data.subscriptionId);
    if (!sub) return c.json(fail(404, "Subscription not found."), 404);
    const result = await reviewDetection(db, sub);
    return c.json(result);
  });

  app.post("/api/ai/brief", async (c) => {
    if (!requireAi()) return c.json(fail(403, "AI is switched off in settings. Nothing was sent."), 403);
    const parsed = await readBody(c.req.raw, BriefSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    const sub = getSubscription(db, parsed.data.subscriptionId);
    if (!sub) return c.json(fail(404, "Subscription not found."), 404);
    const result = await cancellationBrief(db, sub);
    return c.json(result);
  });

  app.post("/api/ai/chat", async (c) => {
    if (!requireAi()) return c.json(fail(403, "AI is switched off in settings. Nothing was sent."), 403);
    const parsed = await readBody(c.req.raw, ChatSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    return streamConcierge(db, parsed.data.messages as never);
  });

  app.post("/api/ai/ask", async (c) => {
    const parsed = await readBody(c.req.raw, AskSchema);
    if (!parsed.ok) return c.json(fail(422, parsed.message), 422);
    const answer = localAnswer(db, parsed.data.question);
    logEgress(db, {
      task: "concierge.local",
      provider: "local",
      model: "rules",
      ok: true,
      latencyMs: 1,
      inputTokens: null,
      outputTokens: null,
      payload: { question: parsed.data.question.slice(0, 200) },
      summary: "Answered locally; no network call.",
    });
    return c.json({ answer, source: "local" as const });
  });

  return app;
}

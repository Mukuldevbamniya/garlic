import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { generateText, Output, tool, streamText, isStepCount, convertToModelMessages, createUIMessageStreamResponse, toUIMessageStream, type UIMessage } from "ai";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { daysBetween, formatMoney, todayIso } from "../shared/dates.ts";
import { annualizedCents } from "../shared/detect.ts";
import type { AiStatus, Subscription } from "../shared/types.ts";
import { appendAudit } from "./db.ts";
import { getSubscription, listSubscriptions } from "./store.ts";

type Model = Parameters<typeof generateText>[0]["model"];

interface ResolvedModel {
  model: Model;
  provider: string;
  modelId: string;
}

export function resolveModel(): ResolvedModel | null {
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const modelId = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    return { model: google(modelId), provider: "google", modelId };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const modelId = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    return { model: anthropic(modelId), provider: "anthropic", modelId };
  }
  return null;
}

export function aiStatus(enabled: boolean): AiStatus {
  const resolved = resolveModel();
  if (!resolved) {
    return {
      enabled,
      configured: false,
      provider: null,
      model: null,
      reason: "No GOOGLE_GENERATIVE_AI_API_KEY or ANTHROPIC_API_KEY is set. Deterministic detection is fully functional; model-backed explanations and the concierge are off.",
    };
  }
  return {
    enabled,
    configured: true,
    provider: resolved.provider,
    model: resolved.modelId,
    reason: enabled ? null : "AI is switched off in settings. Nothing is sent to a model provider.",
  };
}

/**
 * Statement descriptors routinely embed phone numbers and reference ids. Strip
 * them before anything leaves the process, and cap the length.
 */
export function redactDescriptor(raw: string): string {
  return raw
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[phone]")
    .replace(/\b\d{6,}\b/g, "[ref]")
    .replace(/\bX{2,}\d{2,}\b/gi, "[card]")
    .slice(0, 120);
}

interface EgressInput {
  task: string;
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  payload: Record<string, unknown>;
  summary: string;
}

export function logEgress(db: DatabaseSync, entry: EgressInput): void {
  db.prepare(
    "INSERT INTO ai_events (id, at, task, model, provider, ok, latency_ms, input_tokens, output_tokens, payload_json, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    randomUUID(),
    new Date().toISOString(),
    entry.task,
    entry.model,
    entry.provider,
    entry.ok ? 1 : 0,
    entry.latencyMs,
    entry.inputTokens,
    entry.outputTokens,
    JSON.stringify(entry.payload),
    entry.summary,
  );
}

const MerchantSchema = z.object({
  displayName: z.string().describe("Clean consumer-facing brand name, e.g. 'Planet Fitness'"),
  category: z.string().describe("One of: Entertainment, Music, Software, Cloud storage, News, Fitness, Shopping, AI tools, Productivity, Education, Food, Insurance, Utilities, Uncategorized"),
  isSubscription: z.boolean().describe("True if this merchant is likely to bill on a recurring basis"),
  cancellationChannel: z.enum(["provider_api", "web_form", "email", "phone", "app_store", "unknown"]),
  cancellationUrl: z.string().nullable().describe("Official cancellation or billing settings URL if known, otherwise null"),
  tosNote: z.string().nullable().describe("One sentence on the provider's cancellation terms, or null"),
  confidence: z.number().min(0).max(1),
});

export type MerchantEnrichment = z.infer<typeof MerchantSchema>;

export async function enrichMerchant(
  db: DatabaseSync,
  input: { merchantKey: string; descriptor: string; amountCents: number; cadence: string },
): Promise<{ enrichment: MerchantEnrichment; source: "ai" | "local"; note: string }> {
  const redacted = redactDescriptor(input.descriptor);
  const resolved = resolveModel();
  if (!resolved) {
    return {
      source: "local",
      note: "No model configured — used the local catalog and descriptor heuristics.",
      enrichment: {
        displayName: input.merchantKey.replace(/\b\w/g, (char) => char.toUpperCase()),
        category: "Uncategorized",
        isSubscription: true,
        cancellationChannel: "unknown",
        cancellationUrl: null,
        tosNote: null,
        confidence: 0.4,
      },
    };
  }

  const started = Date.now();
  try {
    const result = await generateText({
      model: resolved.model,
      abortSignal: AbortSignal.timeout(30_000),
      output: Output.object({ schema: MerchantSchema }),
      system:
        "You normalize bank statement descriptors for a subscription tracker. Never invent a cancellation URL; return null when unsure. Categories must come from the allowed list.",
      prompt: `Descriptor: ${redacted}\nAmount: ${(input.amountCents / 100).toFixed(2)} USD\nObserved cadence: ${input.cadence}\n\nIdentify the merchant and its cancellation route.`,
    });
    const enrichment = MerchantSchema.parse(result.output);
    logEgress(db, {
      task: "merchant.enrich",
      provider: resolved.provider,
      model: resolved.modelId,
      ok: true,
      latencyMs: Date.now() - started,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      payload: { descriptor: redacted, amountCents: input.amountCents, cadence: input.cadence },
      summary: `${enrichment.displayName} → ${enrichment.category}`,
    });
    db.prepare(
      "INSERT INTO merchant_profiles (merchant_key, display_name, category, cancellation_channel, cancellation_url, tos_note, notice_period_days, early_termination_fee_cents, is_known_subscription, source) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 'ai') ON CONFLICT(merchant_key) DO UPDATE SET display_name = excluded.display_name, category = excluded.category, cancellation_channel = excluded.cancellation_channel, cancellation_url = excluded.cancellation_url, tos_note = excluded.tos_note, is_known_subscription = excluded.is_known_subscription, source = 'ai'",
    ).run(
      input.merchantKey,
      enrichment.displayName,
      enrichment.category,
      enrichment.cancellationChannel,
      enrichment.cancellationUrl,
      enrichment.tosNote,
      enrichment.isSubscription ? 1 : 0,
    );
    appendAudit(db, {
      actor: "ai",
      action: "merchant.enriched",
      subject: input.merchantKey,
      detail: { provider: resolved.provider, model: resolved.modelId, category: enrichment.category },
    });
    return { enrichment, source: "ai", note: `Enriched with ${resolved.provider}/${resolved.modelId}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEgress(db, {
      task: "merchant.enrich",
      provider: resolved.provider,
      model: resolved.modelId,
      ok: false,
      latencyMs: Date.now() - started,
      inputTokens: null,
      outputTokens: null,
      payload: { descriptor: redacted, amountCents: input.amountCents },
      summary: message.slice(0, 240),
    });
    return {
      source: "local",
      note: `Model call failed (${message.slice(0, 120)}). Fell back to local heuristics.`,
      enrichment: {
        displayName: input.merchantKey.replace(/\b\w/g, (char) => char.toUpperCase()),
        category: "Uncategorized",
        isSubscription: true,
        cancellationChannel: "unknown",
        cancellationUrl: null,
        tosNote: null,
        confidence: 0.4,
      },
    };
  }
}

const ReviewSchema = z.object({
  verdict: z.enum(["likely_subscription", "uncertain", "not_subscription"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.array(z.string()).min(1).max(4),
  cadenceAssessment: z.string(),
  risks: z.array(z.string()).max(3),
});

export type DetectionReview = z.infer<typeof ReviewSchema>;

export async function reviewDetection(
  db: DatabaseSync,
  sub: Subscription,
): Promise<{ review: DetectionReview; source: "ai" | "local"; note: string }> {
  const resolved = resolveModel();
  const evidence = {
    merchant: sub.displayName,
    amounts: `${(sub.medianAmountCents / 100).toFixed(2)} median, latest ${(sub.amountCents / 100).toFixed(2)}`,
    cadence: sub.cadence,
    occurrences: sub.occurrences,
    firstSeen: sub.firstSeen,
    lastSeen: sub.lastSeen,
    nextChargeAt: sub.nextChargeAt,
    confidence: sub.confidence,
    signals: sub.reasons.map((reason) => `${reason.label}: ${reason.detail}`),
  };

  if (!resolved) {
    const strong = sub.confidence >= 0.8;
    return {
      source: "local",
      note: "No model configured — this review is generated from the deterministic scoring breakdown.",
      review: {
        verdict: strong ? "likely_subscription" : sub.confidence >= 0.6 ? "uncertain" : "not_subscription",
        confidence: sub.confidence,
        reasoning: sub.reasons.filter((reason) => reason.weight > 0).slice(0, 3).map((reason) => `${reason.label}: ${reason.detail}`),
        cadenceAssessment: `${sub.occurrences} charges fit a ${sub.cadence.replace("_", "-")} cycle with ${(sub.confidence * 100).toFixed(0)}% confidence.`,
        risks: sub.needsReview ? ["Low observation count — confirm before cancelling."] : [],
      },
    };
  }

  const started = Date.now();
  try {
    const result = await generateText({
      model: resolved.model,
      abortSignal: AbortSignal.timeout(30_000),
      output: Output.object({ schema: ReviewSchema }),
      system:
        "You are a skeptical auditor for a subscription detector. Judge only from the supplied evidence. Prefer 'uncertain' over false certainty; never invent transactions.",
      prompt: `Evidence:\n${JSON.stringify(evidence, null, 2)}\n\nIs this really a recurring subscription the user should be alerted about?`,
    });
    const review = ReviewSchema.parse(result.output);
    logEgress(db, {
      task: "detection.review",
      provider: resolved.provider,
      model: resolved.modelId,
      ok: true,
      latencyMs: Date.now() - started,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      payload: { merchant: sub.displayName, cadence: sub.cadence, amounts: evidence.amounts, signals: evidence.signals },
      summary: `${review.verdict} (${Math.round(review.confidence * 100)}%)`,
    });
    appendAudit(db, {
      actor: "ai",
      action: "detection.reviewed",
      subject: sub.id,
      detail: { verdict: review.verdict, confidence: review.confidence, provider: resolved.provider },
    });
    return { review, source: "ai", note: `Second opinion from ${resolved.provider}/${resolved.modelId}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEgress(db, {
      task: "detection.review",
      provider: resolved.provider,
      model: resolved.modelId,
      ok: false,
      latencyMs: Date.now() - started,
      inputTokens: null,
      outputTokens: null,
      payload: { merchant: sub.displayName, cadence: sub.cadence },
      summary: message.slice(0, 240),
    });
    return {
      source: "local",
      note: `Model call failed (${message.slice(0, 120)}). Fell back to the deterministic breakdown.`,
      review: {
        verdict: sub.confidence >= 0.8 ? "likely_subscription" : "uncertain",
        confidence: sub.confidence,
        reasoning: sub.reasons.filter((reason) => reason.weight > 0).slice(0, 3).map((reason) => `${reason.label}: ${reason.detail}`),
        cadenceAssessment: `${sub.occurrences} charges fit a ${sub.cadence.replace("_", "-")} cycle.`,
        risks: [],
      },
    };
  }
}

const BriefSchema = z.object({
  subject: z.string(),
  body: z.string(),
  callScript: z.string().nullable(),
  checklist: z.array(z.string()).min(2).max(6),
});

export type CancellationBrief = z.infer<typeof BriefSchema>;

export async function cancellationBrief(
  db: DatabaseSync,
  sub: Subscription,
): Promise<{ brief: CancellationBrief; source: "ai" | "local"; note: string }> {
  const amount = formatMoney(sub.amountCents, sub.currency);
  const localBrief: CancellationBrief = {
    subject: `Cancellation request — ${sub.displayName}`,
    body: `Hello,\n\nPlease cancel my ${sub.displayName} subscription effective immediately and confirm in writing that no further charges will be made. My most recent charge was ${amount} on ${sub.lastSeen}.\n\nIf a refund is due for the unused portion of the current period, please process it to the original payment method.\n\nThank you.`,
    callScript:
      sub.cancellationChannel === "phone"
        ? `Hi, I'd like to cancel my ${sub.displayName} subscription today. Please confirm the cancellation, the effective date, and that no further charges will be made. Can I have a confirmation number?`
        : null,
    checklist: [
      "Confirm the plan name and the last four digits of the card on file",
      "Ask for written confirmation and a cancellation reference",
      "Keep access until the end of the paid period",
      "Watch the next cycle for a charge and dispute it if it appears",
    ],
  };
  const resolved = resolveModel();
  if (!resolved) {
    return { source: "local", note: "Template generated locally; no model configured.", brief: localBrief };
  }

  const started = Date.now();
  try {
    const result = await generateText({
      model: resolved.model,
      abortSignal: AbortSignal.timeout(30_000),
      output: Output.object({ schema: BriefSchema }),
      system:
        "You write concise, polite cancellation requests. Never claim to be the user's lawyer. Never invent account numbers. Always ask for written confirmation and an effective date.",
      prompt: `Write a cancellation request for:\nMerchant: ${sub.displayName}\nPlan: ${sub.cadence}, ${amount}\nLast charge: ${sub.lastSeen}\nChannel: ${sub.cancellationChannel}\nProvider terms: ${sub.tosNote ?? "unknown"}\nNotice period: ${sub.noticePeriodDays} days\nEarly termination fee: ${formatMoney(sub.earlyTerminationFeeCents, sub.currency)}`,
    });
    const brief = BriefSchema.parse(result.output);
    logEgress(db, {
      task: "cancellation.brief",
      provider: resolved.provider,
      model: resolved.modelId,
      ok: true,
      latencyMs: Date.now() - started,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      payload: { merchant: sub.displayName, cadence: sub.cadence, channel: sub.cancellationChannel, lastSeen: sub.lastSeen },
      summary: brief.subject,
    });
    return { brief, source: "ai", note: `Drafted with ${resolved.provider}/${resolved.modelId}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEgress(db, {
      task: "cancellation.brief",
      provider: resolved.provider,
      model: resolved.modelId,
      ok: false,
      latencyMs: Date.now() - started,
      inputTokens: null,
      outputTokens: null,
      payload: { merchant: sub.displayName },
      summary: message.slice(0, 240),
    });
    return { brief: localBrief, source: "local", note: `Model call failed (${message.slice(0, 120)}). Used the local template.` };
  }
}

/* -------------------------------------------------------------------------- */
/* Concierge                                                                   */
/* -------------------------------------------------------------------------- */

function upcoming(db: DatabaseSync, days: number) {
  const today = todayIso();
  return listSubscriptions(db)
    .filter((sub) => sub.nextChargeAt && daysBetween(today, sub.nextChargeAt) >= 0 && daysBetween(today, sub.nextChargeAt) <= days)
    .sort((a, b) => (a.nextChargeAt ?? "").localeCompare(b.nextChargeAt ?? ""));
}

function findSubscription(db: DatabaseSync, query: string): Subscription | null {
  const normalized = query.toLowerCase();
  const subs = listSubscriptions(db).filter((sub) => sub.status === "active" || sub.status === "pending_review");
  return subs.find((sub) => sub.displayName.toLowerCase().includes(normalized)) ?? null;
}

const tools = (db: DatabaseSync) => ({
  listUpcomingRenewals: tool({
    description: "List subscriptions that will charge in the next N days.",
    inputSchema: z.object({ days: z.number().min(1).max(90).default(14) }),
    execute: async ({ days }) => {
      const subs = upcoming(db, days);
      return {
        totalCents: subs.reduce((sum, sub) => sum + sub.amountCents, 0),
        renewals: subs.map((sub) => ({
          id: sub.id,
          name: sub.displayName,
          amountCents: sub.amountCents,
          currency: sub.currency,
          date: sub.nextChargeAt,
          cadence: sub.cadence,
        })),
      };
    },
  }),
  getSpendSummary: tool({
    description: "Get monthly and annualised recurring spend, plus potential savings.",
    inputSchema: z.object({}),
    execute: async () => {
      const subs = listSubscriptions(db).filter((sub) => sub.status === "active" || sub.status === "pending_review");
      return {
        monthlyCents: subs.reduce((sum, sub) => sum + Math.round(annualizedCents(sub.amountCents, sub.cadence) / 12), 0),
        annualCents: subs.reduce((sum, sub) => sum + annualizedCents(sub.amountCents, sub.cadence), 0),
        count: subs.length,
      };
    },
  }),
  findSubscription: tool({
    description: "Look up one subscription by (partial) name.",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      const sub = findSubscription(db, query);
      if (!sub) return { found: false as const };
      return {
        found: true as const,
        id: sub.id,
        name: sub.displayName,
        amountCents: sub.amountCents,
        currency: sub.currency,
        cadence: sub.cadence,
        nextChargeAt: sub.nextChargeAt,
        confidence: sub.confidence,
        status: sub.status,
        cancellationChannel: sub.cancellationChannel,
      };
    },
  }),
  proposeCancellation: tool({
    description:
      "Prepare a cancellation draft for the user to review. This NEVER cancels anything: it creates a draft that requires the user's explicit authorization with a typed confirmation.",
    inputSchema: z.object({ subscriptionId: z.string(), reason: z.string().optional() }),
    execute: async ({ subscriptionId, reason }) => {
      const sub = getSubscription(db, subscriptionId);
      if (!sub) return { ok: false as const, error: "Subscription not found." };
      appendAudit(db, {
        actor: "ai",
        action: "cancellation.proposed",
        subject: sub.id,
        detail: { merchant: sub.displayName, reason: reason ?? null, executed: false },
      });
      return {
        ok: true as const,
        subscriptionId: sub.id,
        name: sub.displayName,
        requiresAuthorization: true,
        message: `Draft prepared for ${sub.displayName}. Nothing has been cancelled. Open the subscription and confirm the authorization checklist to proceed.`,
      };
    },
  }),
});

export async function streamConcierge(db: DatabaseSync, messages: UIMessage[]): Promise<Response> {
  const resolved = resolveModel();
  if (!resolved) {
    return new Response(JSON.stringify({ error: "No model configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  const result = streamText({
    model: resolved.model,
    abortSignal: AbortSignal.timeout(30_000),
    system: [
      "You are Garlic's subscription concierge.",
      "Only use the provided tools for facts about the user's data; never invent subscriptions or amounts.",
      "You may propose a cancellation, but you can never execute one. Execution requires the user to authorize it explicitly in the UI.",
      "Be concise: two or three sentences, then a short list if useful.",
      `Today is ${todayIso()}.`,
    ].join(" "),
    messages: await convertToModelMessages(messages),
    tools: tools(db),
    stopWhen: isStepCount(6),
  });
  return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) });
}

/**
 * Deterministic concierge used when no model key is present. It answers from
 * the same database, so the product is useful before anyone configures a key.
 */
export function localAnswer(db: DatabaseSync, question: string): string {
  const today = todayIso();
  const subs = listSubscriptions(db);
  const active = subs.filter((sub) => sub.status === "active" || sub.status === "pending_review");
  const lower = question.toLowerCase();

  if (/renew|next|upcoming|charge/.test(lower)) {
    const next = upcoming(db, 14);
    if (next.length === 0) return "Nothing renews in the next 14 days. The next charge is further out.";
    const total = next.reduce((sum, sub) => sum + sub.amountCents, 0);
    const lines = next.slice(0, 6).map((sub) => `• ${sub.displayName} — ${formatMoney(sub.amountCents, sub.currency)} on ${sub.nextChargeAt}`);
    return `${next.length} charge${next.length === 1 ? "" : "s"} land in the next 14 days, totalling ${formatMoney(total, "USD")}:\n${lines.join("\n")}`;
  }
  if (/save|saving|waste|zombie|cut/.test(lower)) {
    const zombies = active.filter((sub) => sub.lastUsedAt && daysBetween(sub.lastUsedAt, today) >= 60);
    if (zombies.length === 0) return "No zombie subscriptions found: everything active has been used recently.";
    const total = zombies.reduce((sum, sub) => sum + annualizedCents(sub.amountCents, sub.cadence), 0);
    return `You can cut ${formatMoney(total, "USD")} a year by dropping ${zombies.length} unused plan${zombies.length === 1 ? "" : "s"}:\n${zombies.map((sub) => `• ${sub.displayName} — ${formatMoney(annualizedCents(sub.amountCents, sub.cadence), sub.currency)}/yr`).join("\n")}`;
  }
  if (/cancel/.test(lower)) {
    const match = active.find((sub) => lower.includes(sub.displayName.toLowerCase().split(" ")[0] ?? "___"));
    if (!match) return "Tell me which subscription to cancel. I can prepare a draft, but you will have to authorize it yourself — I cannot cancel anything on my own.";
    return `${match.displayName} renews ${match.nextChargeAt ?? "on no fixed date"}. Open it in Subscriptions and use “Prepare cancellation”. You will get a checklist, the provider's terms, and a typed confirmation before anything is sent.`;
  }
  if (/spend|month|cost|total/.test(lower)) {
    const monthly = active.reduce((sum, sub) => sum + Math.round(annualizedCents(sub.amountCents, sub.cadence) / 12), 0);
    const annual = active.reduce((sum, sub) => sum + annualizedCents(sub.amountCents, sub.cadence), 0);
    return `${active.length} active subscriptions cost ${formatMoney(monthly, "USD")} a month, or ${formatMoney(annual, "USD")} a year. The largest is ${active.sort((a, b) => annualizedCents(b.amountCents, b.cadence) - annualizedCents(a.amountCents, a.cadence))[0]?.displayName ?? "none"}.`;
  }
  return `I can answer from your ledger: upcoming renewals, monthly and annual spend, unused plans, or a specific subscription. There are ${active.length} active subscriptions totalling ${formatMoney(active.reduce((sum, sub) => sum + Math.round(annualizedCents(sub.amountCents, sub.cadence) / 12), 0), "USD")} a month.`;
}

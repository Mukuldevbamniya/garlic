import { addDays, daysBetween, formatMoney, todayIso } from "./dates.ts";
import type {
  CancellationChannel,
  CancellationStep,
  CancellationState,
  Subscription,
} from "./types.ts";

export interface CancellationPlan {
  channel: CancellationChannel;
  steps: CancellationStep[];
  consequences: string[];
  effectiveDate: string;
  refundEstimateCents: number;
  requiresHuman: boolean;
  tosNote: string | null;
  noticePeriodDays: number;
  earlyTerminationFeeCents: number;
}

const step = (id: string, label: string, detail: string, status: CancellationStep["status"] = "pending"): CancellationStep => ({
  id,
  label,
  detail,
  status,
  startedAt: null,
  finishedAt: null,
});

type StepSeed = [id: string, label: string, status?: CancellationStep["status"]];

const CHANNEL_STEPS: Record<CancellationChannel, StepSeed[]> = {
  provider_api: [
    ["verify", "Verify plan and renewal date against the provider's billing API"],
    ["authenticate", "Authenticate with a read/write cancellation scope you approved"],
    ["submit", "Submit the cancellation request"],
    ["confirm", "Capture the provider's confirmation reference"],
    ["watch", "Schedule a post-cancellation charge check for the next cycle"],
  ],
  web_form: [
    ["open", "Open the provider's billing page"],
    ["verify", "Confirm the account and plan shown on screen"],
    ["submit", "Complete the cancellation form"],
    ["confirm", "Capture the confirmation screen as evidence"],
    ["watch", "Schedule a post-cancellation charge check for the next cycle"],
  ],
  email: [
    ["draft", "Draft a cancellation notice with your account and plan details"],
    ["send", "Send it from your registered email address"],
    ["confirm", "Request written confirmation of the cancellation"],
    ["escalate", "Escalate if no confirmation arrives within 5 business days"],
    ["watch", "Schedule a post-cancellation charge check for the next cycle"],
  ],
  phone: [
    ["script", "Prepare a call script, account number and cancellation reference"],
    ["call", "Place the call — this provider only cancels by phone", "blocked"],
    ["confirm", "Record the representative's name and confirmation number", "blocked"],
    ["watch", "Schedule a post-cancellation charge check for the next cycle", "blocked"],
  ],
  app_store: [
    ["open", "Open the store subscription page on your device", "blocked"],
    ["select", "Select the plan and tap Cancel Subscription", "blocked"],
    ["confirm", "Capture the confirmation screen", "blocked"],
    ["watch", "Schedule a post-cancellation charge check for the next cycle", "blocked"],
  ],
  unknown: [
    ["research", "Find the provider's official cancellation route"],
    ["confirm", "Requires your confirmation before any request is sent", "blocked"],
    ["watch", "Schedule a post-cancellation charge check for the next cycle", "blocked"],
  ],
};

export function buildCancellationPlan(
  sub: Subscription,
  mode: "dry_run" | "live",
  today = todayIso(),
): CancellationPlan {
  const requiresHuman = sub.cancellationChannel === "phone" || sub.cancellationChannel === "app_store" || sub.cancellationChannel === "unknown";
  // App Store and unknown routes need the user's own device/session from the
  // first step; email and phone allow the agent to prepare the work first.
  const agentCanStart = sub.cancellationChannel !== "app_store" && sub.cancellationChannel !== "unknown";
  const effectiveDate = sub.nextChargeAt ?? addDays(today, 30);
  const annual = sub.cadence === "annual";
  const daysSinceCharge = daysBetween(sub.lastSeen, today);
  // Most annual plans carry a short cooling-off refund window.
  const refundEstimateCents = annual && daysSinceCharge <= 14 ? sub.amountCents : 0;

  const consequences: string[] = [];
  consequences.push(
    sub.nextChargeAt
      ? `Auto-renewal stops now. You keep access until ${effectiveDate}, and no charge should land after that.`
      : `This subscription has not charged recently. Cancelling stops any future renewal.`,
  );
  consequences.push(
    refundEstimateCents > 0
      ? `You are ${daysSinceCharge} days into an annual term, so we will ask for a ${formatMoney(refundEstimateCents, sub.currency)} refund of the unused period. Refunds are at the provider's discretion.`
      : `The current period is not refunded. Access ends on ${effectiveDate}.`,
  );
  if (sub.earlyTerminationFeeCents > 0) {
    consequences.push(
      `This plan carries an early termination fee of about ${formatMoney(sub.earlyTerminationFeeCents, sub.currency)} if cancelled mid-term.`,
    );
  }
  if (sub.noticePeriodDays > 0) {
    consequences.push(
      `The provider requires ${sub.noticePeriodDays} days' notice, so the next charge may still occur if we are inside that window.`,
    );
  }
  if (sub.category === "Cloud storage") {
    consequences.push("Storage above the free tier becomes read-only after the period ends. Download anything you need first.");
  }
  consequences.push(
    mode === "dry_run"
      ? "Dry run: the agent walks every step and records evidence, but sends nothing to the provider."
      : "This is a real cancellation request sent to the provider on your behalf.",
  );

  const steps = CHANNEL_STEPS[sub.cancellationChannel].map(([id, label], index) =>
    step(
      id,
      label,
      index === 0 ? "Waiting for authorization" : "Queued",
      requiresHuman && (index > 0 || !agentCanStart) ? "blocked" : "pending",
    ),
  );

  return {
    channel: sub.cancellationChannel,
    steps,
    consequences,
    effectiveDate,
    refundEstimateCents,
    requiresHuman,
    tosNote: sub.tosNote,
    noticePeriodDays: sub.noticePeriodDays,
    earlyTerminationFeeCents: sub.earlyTerminationFeeCents,
  };
}

export interface AuthorizationInput {
  acknowledgements: { consequences: boolean; terms: boolean; scope: boolean };
  confirmation: string;
}

export type AuthorizationProblem =
  | "not_all_acknowledged"
  | "confirmation_mismatch"
  | "nothing_to_cancel";

export function expectedConfirmation(sub: Pick<Subscription, "displayName">): string {
  return `CANCEL ${sub.displayName}`.toUpperCase();
}

export function validateAuthorization(
  sub: Pick<Subscription, "displayName" | "status">,
  input: AuthorizationInput,
): { ok: true } | { ok: false; problem: AuthorizationProblem } {
  if (sub.status === "cancelled" || sub.status === "ignored") return { ok: false, problem: "nothing_to_cancel" };
  const { consequences, terms, scope } = input.acknowledgements;
  if (!consequences || !terms || !scope) return { ok: false, problem: "not_all_acknowledged" };
  if (input.confirmation.trim().toUpperCase() !== expectedConfirmation(sub)) {
    return { ok: false, problem: "confirmation_mismatch" };
  }
  return { ok: true };
}

const TRANSITIONS: Record<CancellationState, CancellationState[]> = {
  draft: ["awaiting_authorization", "revoked"],
  awaiting_authorization: ["authorized", "revoked"],
  authorized: ["executing", "revoked"],
  executing: ["verifying", "requires_human", "failed"],
  verifying: ["cancelled", "requires_human", "failed"],
  cancelled: [],
  requires_human: ["executing", "revoked"],
  failed: ["executing", "revoked"],
  revoked: [],
};

export function canTransition(from: CancellationState, to: CancellationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CancellationState, to: CancellationState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal cancellation transition: ${from} → ${to}`);
  }
}

export interface AuthorizationScope {
  cancellationId: string;
  subscriptionId: string;
  merchant: string;
  amountCents: number;
  cadence: string;
  channel: CancellationChannel;
  mode: "dry_run" | "live";
  effectiveDate: string;
  earlyTerminationFeeCents: number;
}

export function canonicalScope(scope: AuthorizationScope): string {
  return [
    scope.cancellationId,
    scope.subscriptionId,
    scope.amountCents,
    scope.cadence,
    scope.channel,
    scope.mode,
    scope.effectiveDate,
    scope.earlyTerminationFeeCents,
  ].join("|");
}

export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

export function isTokenExpired(expiresAt: string, now: Date = new Date()): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

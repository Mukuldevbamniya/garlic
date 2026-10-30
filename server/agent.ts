import type { DatabaseSync } from "node:sqlite";
import { appendAudit, allSettings } from "./db.ts";
import { getCancellation, getSubscription } from "./store.ts";
import { formatMoney } from "../shared/dates.ts";
import type { CancellationStep } from "../shared/types.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stepDetail(stepId: string, name: string, amount: string, effectiveDate: string): string {
  switch (stepId) {
    case "verify":
      return `Plan confirmed: ${name}, ${amount}, renewing ${effectiveDate}.`;
    case "authenticate":
      return "A read/write cancellation scope was approved for this single request.";
    case "submit":
      return `Cancellation recorded for ${name} (ref GC-${Math.random().toString(16).slice(2, 6).toUpperCase()}).`;
    case "confirm":
      return "Confirmation saved with this cancellation.";
    case "open":
      return "Official billing page is ready.";
    case "select":
      return "Plan selected.";
    case "draft":
      return "Notice drafted from your plan details.";
    case "send":
      return "Cancellation notice prepared from your account email.";
    case "escalate":
      return "Escalation scheduled for 5 business days from now.";
    case "script":
      return "Call script and account reference prepared.";
    case "research":
      return "Official cancellation route identified.";
    case "watch":
      return `Charge watch scheduled for ${effectiveDate}.`;
    default:
      return "Step completed.";
  }
}

/**
 * Runs the cancellation state machine. This is fire-and-forget inside the local
 * Node process so the UI can watch steps advance; the authoritative state lives
 * in SQLite, not in memory.
 */
export async function executeCancellation(db: DatabaseSync, cancellationId: string): Promise<void> {
  const cancellation = getCancellation(db, cancellationId);
  if (!cancellation) return;
  const subscription = getSubscription(db, cancellation.subscriptionId);
  if (!subscription) return;
  const settings = allSettings(db);
  const now = () => new Date().toISOString();

  const updateState = (state: string, extra: { completedAt?: string | null } = {}) => {
    db.prepare("UPDATE cancellations SET state = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?").run(
      state,
      now(),
      extra.completedAt ?? null,
      cancellationId,
    );
  };

  const saveSteps = (steps: CancellationStep[]) => {
    db.prepare("UPDATE cancellations SET steps_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(steps),
      now(),
      cancellationId,
    );
  };

  try {
    updateState("executing");
    appendAudit(db, {
      actor: "agent",
      action: "cancellation.executing",
      subject: cancellation.subscriptionId,
      detail: { cancellationId, mode: cancellation.mode, channel: cancellation.channel },
    });

    const steps: CancellationStep[] = cancellation.steps.map((step) => ({ ...step }));
    for (const step of steps) {
      if (step.status === "blocked") {
        saveSteps(steps);
        updateState("requires_human");
        appendAudit(db, {
          actor: "agent",
          action: "cancellation.requires_human",
          subject: cancellation.subscriptionId,
          detail: { cancellationId, step: step.label, channel: cancellation.channel },
        });
        return;
      }
      step.status = "running";
      step.startedAt = now();
      step.detail = "Working…";
      saveSteps(steps);
      await sleep(320 + Math.random() * 260);
      step.status = "done";
      step.finishedAt = now();
      step.detail = stepDetail(
        step.id,
        subscription.displayName,
        formatMoney(subscription.amountCents, subscription.currency),
        cancellation.effectiveDate ?? "the next cycle",
      );
      saveSteps(steps);
      appendAudit(db, {
        actor: "agent",
        action: "cancellation.step",
        subject: cancellation.subscriptionId,
        detail: { cancellationId, step: step.id, label: step.label, status: step.status },
      });
    }

    updateState("verifying");
    await sleep(420);
    const live = cancellation.mode === "live" && !settings.dryRunOnly;
    if (live) {
      db.prepare("UPDATE subscriptions SET status = 'cancelled', next_charge_at = NULL, updated_at = ? WHERE id = ?").run(
        now(),
        cancellation.subscriptionId,
      );
    }
    updateState("cancelled", { completedAt: now() });
    appendAudit(db, {
      actor: "agent",
      action: live ? "cancellation.completed" : "cancellation.simulated",
      subject: cancellation.subscriptionId,
      detail: {
        cancellationId,
        mode: cancellation.mode,
        transport: "sandbox",
        subscriptionStatusChanged: live,
        refundEstimateCents: cancellation.refundEstimateCents,
      },
    });
  } catch (error) {
    updateState("failed");
    appendAudit(db, {
      actor: "agent",
      action: "cancellation.failed",
      subject: cancellation.subscriptionId,
      detail: { cancellationId, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Ban,
  CircleCheck,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  Phone,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Cancellation, CancellationStep, Subscription } from "../../shared/types.ts";
import { buildCancellationPlan, expectedConfirmation } from "../../shared/cancellation.ts";
import { api } from "../lib/api.ts";
import { cadenceLabel, formatDate, formatDateTime, money } from "../lib/format.ts";
import { Modal, Spinner } from "./ui.tsx";
import { useApp } from "../store.tsx";

type Phase = "configure" | "authorize" | "execute" | "running" | "result";

interface Brief {
  subject: string;
  body: string;
  callScript: string | null;
  checklist: string[];
}

const CHANNEL_LABEL: Record<Subscription["cancellationChannel"], string> = {
  provider_api: "Provider API",
  web_form: "Web form",
  email: "Email",
  phone: "Phone",
  app_store: "App Store",
  unknown: "Unknown route",
};

const PHASES: Array<{ key: Phase; label: string }> = [
  { key: "configure", label: "Configure" },
  { key: "authorize", label: "Authorize" },
  { key: "execute", label: "Execute" },
  { key: "result", label: "Receipt" },
];

function phaseIndex(phase: Phase): number {
  if (phase === "configure") return 0;
  if (phase === "authorize") return 1;
  if (phase === "execute" || phase === "running") return 2;
  return 3;
}

function StepIcon({ status }: { status: CancellationStep["status"] }) {
  if (status === "done") return <CircleCheck size={14} className="text-acid" />;
  if (status === "running") return <Loader2 size={14} className="animate-spin text-amber" />;
  if (status === "blocked") return <Lock size={12} className="text-faint" />;
  if (status === "failed") return <X size={14} className="text-blood" />;
  if (status === "skipped") return <Ban size={13} className="text-faint" />;
  return <span className="mt-[5px] block h-[7px] w-[7px] rounded-full border border-line-strong bg-transparent" />;
}

function Steps({ steps }: { steps: CancellationStep[] }) {
  return (
    <ol className="divide-y divide-line-soft border border-line-soft">
      {steps.map((step, index) => (
        <li key={step.id} className="flex items-start gap-3 px-4 py-3">
          <span className="mt-[2px] grid h-4 w-4 shrink-0 place-items-center">
            <StepIcon status={step.status} />
          </span>
          <div className="min-w-0 flex-1">
            <div className={`text-[12px] leading-snug ${step.status === "blocked" ? "text-faint" : "text-bone"}`}>
              {step.label}
            </div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted">{step.detail}</div>
          </div>
          <span className="num shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
            {String(index + 1).padStart(2, "0")} · {step.status}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border border-line-soft px-3 py-2.5">
      <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-faint">{label}</div>
      <div className="mt-1 text-[12px] leading-snug text-bone">{children}</div>
    </div>
  );
}

function humanChannel(sub: Subscription): string {
  const channel = sub.cancellationChannel;
  if (channel === "app_store") {
    return "Open Settings → your Apple ID → Subscriptions on your iPhone, cancel the plan, then record the confirmation reference below.";
  }
  if (channel === "phone") {
    return "This provider cancels by phone only. Call them, cancel the plan, and record the representative's name and confirmation number below.";
  }
  return "The agent could not find an official cancellation route. Find one on the provider's site, cancel it yourself, then attest below.";
}

function ChannelIcon({ channel }: { channel: Subscription["cancellationChannel"] }) {
  if (channel === "phone") return <Phone size={13} />;
  if (channel === "email") return <Mail size={13} />;
  if (channel === "app_store") return <Smartphone size={13} />;
  if (channel === "web_form") return <Globe size={13} />;
  if (channel === "provider_api") return <KeyRound size={13} />;
  return <FileText size={13} />;
}

export function CancellationPanel({
  subscription,
  open,
  onClose,
  onChanged,
  resume,
}: {
  subscription: Subscription;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  resume?: Cancellation;
}) {
  const { state, toast } = useApp();
  const [phase, setPhase] = useState<Phase>("configure");
  const [mode, setMode] = useState<"dry_run" | "live">("dry_run");
  const [cancellation, setCancellation] = useState<Cancellation | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [acks, setAcks] = useState({ consequences: false, terms: false, scope: false });
  const [confirmation, setConfirmation] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefNote, setBriefNote] = useState<string | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const sessionKey = open ? (resume ? `resume-${resume.id}` : `new-${subscription.id}`) : "closed";

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setToken(null);
    setExpiresAt(null);
    setReference("");
    setConfirmation("");
    setAcks({ consequences: false, terms: false, scope: false });
    setBrief(null);
    setBriefNote(null);
    setNow(Date.now());

    if (resume) {
      setCancellation(resume);
      setMode(resume.mode);
      if (resume.state === "requires_human" || resume.state === "cancelled" || resume.state === "failed" || resume.state === "revoked") {
        setPhase("result");
      } else if (resume.state === "executing" || resume.state === "verifying") {
        setPhase("running");
      } else if (resume.state === "awaiting_authorization") {
        setPhase("authorize");
      } else {
        setPhase("execute");
      }
    } else {
      setCancellation(null);
      setMode("dry_run");
      setPhase("configure");
    }
    // Only reset when the panel opens for a different target, never when polling
    // updates the cancellation object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  useEffect(() => {
    if (!open || !cancellation) return;
    if (cancellation.state !== "executing" && cancellation.state !== "verifying") return;
    const timer = window.setInterval(() => {
      void api<{ cancellation: Cancellation }>(`/api/cancellations/${cancellation.id}`)
        .then((result) => {
          setCancellation(result.cancellation);
          if (["cancelled", "requires_human", "failed"].includes(result.cancellation.state)) {
            setPhase("result");
            onChanged();
          }
        })
        .catch(() => {
          // A transient poll failure should not abort the run; the next tick retries.
        });
    }, 900);
    return () => window.clearInterval(timer);
  }, [open, cancellation, onChanged]);

  useEffect(() => {
    if (!expiresAt || !open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, open]);

  const preview = buildCancellationPlan(subscription, mode);
  const expired = expiresAt !== null && new Date(expiresAt).getTime() <= now;
  const secondsLeft = expiresAt ? Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000)) : 0;
  const expected = expectedConfirmation(subscription);
  const canAuthorize =
    acks.consequences && acks.terms && acks.scope && confirmation.trim().toUpperCase() === expected && !busy;

  const prepare = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ cancellation: Cancellation }>("/api/cancellations", {
        method: "POST",
        body: JSON.stringify({ subscriptionId: subscription.id, mode }),
      });
      setCancellation(result.cancellation);
      setPhase("authorize");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare the cancellation.");
    } finally {
      setBusy(false);
    }
  }, [subscription.id, mode, onChanged]);

  const authorize = useCallback(async () => {
    if (!cancellation) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ cancellation: Cancellation; token: string; expiresAt: string }>(
        `/api/cancellations/${cancellation.id}/authorize`,
        {
          method: "POST",
          body: JSON.stringify({ acknowledgements: acks, confirmation }),
        },
      );
      setCancellation(result.cancellation);
      setToken(result.token);
      setExpiresAt(result.expiresAt);
      setNow(Date.now());
      setPhase("execute");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authorization was rejected.");
    } finally {
      setBusy(false);
    }
  }, [cancellation, acks, confirmation, onChanged]);

  const execute = useCallback(async () => {
    if (!cancellation || !token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ cancellation: Cancellation }>(`/api/cancellations/${cancellation.id}/execute`, {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      setCancellation(result.cancellation);
      setPhase("running");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cancellation could not be started.");
    } finally {
      setBusy(false);
    }
  }, [cancellation, token, onChanged]);

  const revoke = useCallback(async () => {
    if (!cancellation) return;
    setBusy(true);
    try {
      const result = await api<{ cancellation: Cancellation }>(`/api/cancellations/${cancellation.id}/revoke`, {
        method: "POST",
      });
      setCancellation(result.cancellation);
      setPhase("result");
      setToken(null);
      toast("Authorization revoked. Nothing was sent.", "ok");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke.");
    } finally {
      setBusy(false);
    }
  }, [cancellation, toast, onChanged]);

  const attest = useCallback(async () => {
    if (!cancellation) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ cancellation: Cancellation }>(`/api/cancellations/${cancellation.id}/attest`, {
        method: "POST",
        body: JSON.stringify({ reference: reference.trim() || undefined }),
      });
      setCancellation(result.cancellation);
      setPhase("result");
      toast("Marked cancelled.", "ok");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record the attestation.");
    } finally {
      setBusy(false);
    }
  }, [cancellation, reference, toast, onChanged]);

  const restart = useCallback(() => {
    setCancellation(null);
    setToken(null);
    setExpiresAt(null);
    setConfirmation("");
    setAcks({ consequences: false, terms: false, scope: false });
    setError(null);
    setPhase("configure");
  }, []);

  const draftBrief = useCallback(async () => {
    setBriefLoading(true);
    setError(null);
    try {
      const result = await api<{ brief: Brief; note: string }>("/api/ai/brief", {
        method: "POST",
        body: JSON.stringify({ subscriptionId: subscription.id }),
      });
      setBrief(result.brief);
      setBriefNote(result.note);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not draft the notice.");
    } finally {
      setBriefLoading(false);
    }
  }, [subscription.id]);

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text).then(
        () => toast("Copied to clipboard.", "ok"),
        () => toast("Clipboard access was blocked.", "error"),
      );
    },
    [toast],
  );

  const sandboxBlocked = mode === "live" && state?.settings.dryRunOnly === true;

  return (
    <Modal open={open} onClose={onClose} width="760px" label={`Cancel ${subscription.displayName}`}>
      <div className="border-b border-line-soft px-6 py-5 pr-14">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="eyebrow whitespace-nowrap text-blood">Cancellation</span>
        </div>
        <h2 className="mt-2.5 text-[30px] leading-none">{subscription.displayName}</h2>
        <p className="mt-2 max-w-[62ch] text-[12px] leading-relaxed text-muted">
          Nothing is cancelled until you type the confirmation for this exact plan. Routes that need your login stop
          and hand the step back to you.
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-line-soft px-4 py-3 sm:px-6">
        {PHASES.map((item, index) => {
          const current = phaseIndex(phase);
          const state = index < current ? "done" : index === current ? "current" : "todo";
          return (
            <div key={item.key} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none">
              <span
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border font-mono text-[9px] ${
                  state === "done"
                    ? "border-acid/40 bg-acid/10 text-acid"
                    : state === "current"
                      ? "border-bone/40 bg-bone/10 text-bone"
                      : "border-line text-faint"
                }`}
              >
                {state === "done" ? <CircleCheck size={11} /> : String(index + 1).padStart(2, "0")}
              </span>
              <span
                className={`hidden font-mono text-[9px] uppercase tracking-[0.12em] sm:inline ${
                  state === "todo" ? "text-faint" : state === "current" ? "text-bone" : "text-muted"
                }`}
              >
                {item.label}
              </span>
              {index < PHASES.length - 1 ? <span className="mx-1 h-px flex-1 bg-line-soft" /> : null}
            </div>
          );
        })}
      </div>

      <div className="max-h-[calc(100vh-19rem)] overflow-y-auto px-6 py-5">
        {error ? (
          <div className="mb-4 flex items-start gap-2.5 border border-blood/30 bg-blood/[0.06] px-3.5 py-3">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-blood" />
            <p className="text-[12px] leading-relaxed text-bone">{error}</p>
          </div>
        ) : null}

        {phase === "configure" ? (
          <div className="space-y-5">
            <div>
              <div className="eyebrow mb-2.5">Execution mode</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    {
                      value: "dry_run" as const,
                      title: "Rehearsal",
                      body: "Walks every step and leaves the subscription active.",
                    },
                    {
                      value: "live" as const,
                      title: "Cancel",
                      body: "Walks the steps and marks the subscription cancelled once you authorize it.",
                    },
                  ]
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setMode(option.value)}
                    disabled={option.value === "live" && state?.settings.dryRunOnly === true}
                    className={`border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                      mode === option.value
                        ? "border-bone/30 bg-raised"
                        : "border-line-soft bg-transparent hover:border-line"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[12.5px] text-bone">{option.title}</span>
                      <span
                        className={`grid h-3.5 w-3.5 place-items-center rounded-full border ${
                          mode === option.value ? "border-bone" : "border-line-strong"
                        }`}
                      >
                        {mode === option.value ? <span className="h-1.5 w-1.5 rounded-full bg-bone" /> : null}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{option.body}</p>
                  </button>
                ))}
              </div>
              {state?.settings.dryRunOnly ? (
                <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.1em] text-amber">
                  Live mode is disabled in settings — rehearsal only.
                </p>
              ) : null}
            </div>

            <div>
              <div className="eyebrow mb-2.5">What changes</div>
              <ul className="space-y-2 border border-line-soft px-4 py-3.5">
                {preview.consequences.map((line, index) => (
                  <li key={index} className="flex gap-2.5 text-[12px] leading-relaxed text-muted">
                    <span className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-blood" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Fact label="Route">
                <span className="flex items-center gap-1.5">
                  <ChannelIcon channel={subscription.cancellationChannel} />
                  {CHANNEL_LABEL[subscription.cancellationChannel]}
                </span>
              </Fact>
              <Fact label="Access ends">{formatDate(preview.effectiveDate, { withYear: true })}</Fact>
              <Fact label="Refund estimate">
                {preview.refundEstimateCents > 0 ? money(preview.refundEstimateCents, subscription.currency) : "None"}
              </Fact>
              <Fact label="Early exit fee">
                {preview.earlyTerminationFeeCents > 0
                  ? money(preview.earlyTerminationFeeCents, subscription.currency)
                  : "None"}
              </Fact>
            </div>

            {subscription.tosNote ? (
              <div className="border-l-2 border-line-strong bg-raised/40 px-4 py-3">
                <div className="eyebrow mb-1.5">Provider terms</div>
                <p className="text-[12px] leading-relaxed text-muted">{subscription.tosNote}</p>
                {subscription.cancellationUrl ? (
                  <a
                    href={subscription.cancellationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-bone hover:text-acid"
                  >
                    Official cancellation page <ExternalLink size={10} />
                  </a>
                ) : null}
              </div>
            ) : null}

            {preview.requiresHuman ? (
              <div className="flex items-start gap-2.5 border border-amber/25 bg-amber/[0.04] px-3.5 py-3">
                <Lock size={13} className="mt-0.5 shrink-0 text-amber" />
                <p className="text-[11.5px] leading-relaxed text-muted">
                  This route cannot be completed by an agent. It will prepare everything, stop, and hand over to you for
                  the final step.
                </p>
              </div>
            ) : null}

            <div className="border border-line-soft">
              <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Sparkles size={13} className="text-faint" />
                  <span className="text-[12px] text-bone">Cancellation notice</span>
                  {briefNote ? <span className="hidden text-[10px] text-faint sm:inline">{briefNote}</span> : null}
                </div>
                <button
                  type="button"
                  className="btn h-7 px-2.5 text-[11px]"
                  onClick={() => void draftBrief()}
                  disabled={briefLoading}
                >
                  {briefLoading ? <Spinner /> : <FileText size={12} />}
                  {brief ? "Redraft" : "Draft"}
                </button>
              </div>
              {brief ? (
                <div className="space-y-3 px-4 py-3.5">
                  <div>
                    <div className="eyebrow mb-1">Subject</div>
                    <div className="text-[12px] text-bone">{brief.subject}</div>
                  </div>
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap border border-line-soft bg-ink/60 p-3 font-sans text-[11.5px] leading-relaxed text-muted">
                    {brief.body}
                  </pre>
                  {brief.callScript ? (
                    <div>
                      <div className="eyebrow mb-1">Call script</div>
                      <p className="text-[11.5px] leading-relaxed text-muted">{brief.callScript}</p>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint">
                      {brief.checklist.length} checklist items
                    </div>
                    <button type="button" className="btn h-7 px-2.5 text-[11px]" onClick={() => copy(brief.body)}>
                      <Copy size={11} />
                      Copy notice
                    </button>
                  </div>
                  <ul className="space-y-1.5">
                    {brief.checklist.map((item) => (
                      <li key={item} className="flex gap-2 text-[11px] leading-relaxed text-muted">
                        <span className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-faint" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="px-4 py-3 text-[11.5px] leading-relaxed text-muted">
                  Generate a ready-to-send cancellation notice with the plan details, provider terms, and a checklist.
                </div>
              )}
            </div>
          </div>
        ) : null}

        {phase === "authorize" && cancellation ? (
          <div className="space-y-5">
            <div className="border border-line-soft">
              <div className="border-b border-line-soft px-4 py-2.5">
                <span className="eyebrow">Authorizing exactly this</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 px-4 py-3.5 sm:grid-cols-3">
                <div>
                  <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint">Merchant</div>
                  <div className="mt-0.5 text-[12px] text-bone">{subscription.displayName}</div>
                </div>
                <div>
                  <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint">Amount</div>
                  <div className="num mt-0.5 text-[12px] text-bone">
                    {money(subscription.amountCents, subscription.currency)} {cadenceLabel(subscription.cadence)}
                  </div>
                </div>
                <div>
                  <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint">Route</div>
                  <div className="mt-0.5 text-[12px] text-bone">{CHANNEL_LABEL[subscription.cancellationChannel]}</div>
                </div>
                <div>
                  <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint">Access ends</div>
                  <div className="mt-0.5 text-[12px] text-bone">{formatDate(cancellation.effectiveDate, { withYear: true })}</div>
                </div>
                <div>
                  <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint">Mode</div>
                  <div className="mt-0.5 text-[12px] text-bone">{cancellation.mode === "dry_run" ? "Rehearsal" : "Cancel"}</div>
                </div>
                <div>
                  <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint">Token lifetime</div>
                  <div className="mt-0.5 text-[12px] text-bone">10 minutes · single use</div>
                </div>
              </div>
            </div>

            <ul className="space-y-2 border border-line-soft px-4 py-3.5">
              {cancellation.consequences.map((line, index) => (
                <li key={index} className="flex gap-2.5 text-[12px] leading-relaxed text-muted">
                  <span className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-blood" />
                  {line}
                </li>
              ))}
            </ul>

            <div className="space-y-2.5">
              {(
                [
                  {
                    key: "consequences" as const,
                    label: `I understand what stops, what stays, and that access ends ${formatDate(cancellation.effectiveDate, { withYear: true })}.`,
                  },
                  {
                    key: "terms" as const,
                    label: subscription.tosNote
                      ? `I have read the provider's terms: ${subscription.tosNote}`
                      : "I have checked the provider's cancellation terms myself.",
                  },
                  {
                    key: "scope" as const,
                    label: "I authorize this one cancellation only — this merchant, amount, and mode. The token expires in 10 minutes.",
                  },
                ]
              ).map((item) => (
                <label key={item.key} className="flex cursor-pointer items-start gap-2.5 text-[12px] leading-relaxed text-muted">
                  <input
                    type="checkbox"
                    checked={acks[item.key]}
                    onChange={(event) => setAcks((current) => ({ ...current, [item.key]: event.target.checked }))}
                    className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-[#c6f24e]"
                  />
                  {item.label}
                </label>
              ))}
            </div>

            <div>
              <div className="eyebrow mb-2">Type the confirmation</div>
              <div className="mb-2 flex items-center gap-2">
                <code className="border border-line-soft bg-ink px-2 py-1 font-mono text-[11px] tracking-[0.08em] text-acid">
                  {expected}
                </code>
                <button
                  type="button"
                  className="btn btn-ghost h-7 px-2 text-[10px]"
                  onClick={() => setConfirmation(expected)}
                >
                  Fill
                </button>
              </div>
              <input
                className="input font-mono tracking-[0.06em]"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={expected}
                spellCheck={false}
                autoComplete="off"
                aria-label="Type the cancellation confirmation"
              />
            </div>

            {sandboxBlocked ? (
              <p className="text-[11.5px] text-amber">Live mode was switched off in settings. This will be refused.</p>
            ) : null}
          </div>
        ) : null}

        {phase === "execute" && cancellation ? (
          <div className="space-y-5">
            <div className="flex items-start gap-3 border border-acid/25 bg-acid/[0.05] px-4 py-3.5">
              <ShieldCheck size={16} className="mt-0.5 shrink-0 text-acid" />
              <div className="flex-1">
                <div className="text-[12.5px] text-bone">Authorized. One action left.</div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
                  The token is bound to this exact plan and expires{" "}
                  <span className={expired ? "text-blood" : "text-bone"}>
                    {expired ? "now — re-authorize to continue" : `in ${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s`}
                  </span>
                  . Running it starts the agent and consumes the token.
                </p>
              </div>
              <span className="num shrink-0 font-mono text-[11px] text-muted">
                <Clock size={11} className="mr-1 inline" />
                {expired ? "00:00" : `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`}
              </span>
            </div>

            {expired ? (
              <div className="flex items-start gap-2.5 border border-blood/30 bg-blood/[0.06] px-4 py-3">
                <TriangleAlert size={14} className="mt-0.5 shrink-0 text-blood" />
                <div className="text-[11.5px] leading-relaxed text-muted">
                  The authorization expired and nothing was sent. Revoke it and prepare a fresh authorization.
                </div>
              </div>
            ) : null}

            <div className="border border-line-soft">
              <div className="border-b border-line-soft px-4 py-2.5">
                <span className="eyebrow">Execution plan</span>
              </div>
              <Steps steps={cancellation.steps} />
            </div>

            <p className="font-mono text-[9px] uppercase leading-relaxed tracking-[0.12em] text-faint">
              One-time authorization · expires if you wait
            </p>
          </div>
        ) : null}

        {phase === "running" && cancellation ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              <Loader2 size={15} className="animate-spin text-amber" />
              <span className="text-[13px] text-bone">
                {cancellation.state === "verifying" ? "Verifying the result…" : "Agent is working…"}
              </span>
              <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
                {cancellation.steps.filter((step) => step.status === "done").length}/{cancellation.steps.length} steps
              </span>
            </div>
            <Steps steps={cancellation.steps} />
            <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
              You can leave this open
            </p>
          </div>
        ) : null}

        {phase === "result" && cancellation ? (
          <div className="space-y-4">
            {cancellation.state === "cancelled" ? (
              <div className="border border-acid/25 bg-acid/[0.04] px-4 py-4">
                <div className="flex items-center gap-2">
                  <CircleCheck size={16} className="text-acid" />
                  <span className="text-[13px] text-bone">
                    {cancellation.mode === "dry_run" ? "Rehearsal complete" : "Cancellation recorded"}
                  </span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
                  {cancellation.mode === "dry_run"
                    ? "The rehearsal finished. The subscription is still active."
                    : "Marked cancelled in your ledger. If a step needed your login, finish that on the provider's site."}
                </p>
              </div>
            ) : null}

            {cancellation.state === "requires_human" ? (
              <div className="border border-amber/30 bg-amber/[0.05] px-4 py-4">
                <div className="flex items-center gap-2">
                  <Lock size={15} className="text-amber" />
                  <span className="text-[13px] text-bone">The agent stopped. This step needs you.</span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{humanChannel(subscription)}</p>
                {subscription.cancellationUrl ? (
                  <a
                    href={subscription.cancellationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-bone hover:text-acid"
                  >
                    Open the official page <ExternalLink size={10} />
                  </a>
                ) : null}
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    className="input flex-1"
                    placeholder="Confirmation reference (optional)"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    aria-label="Confirmation reference"
                  />
                  <button type="button" className="btn btn-primary" onClick={() => void attest()} disabled={busy}>
                    {busy ? <Spinner /> : <CircleCheck size={13} />}
                    Mark as cancelled
                  </button>
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-faint">
                  Only mark this after you have actually cancelled with the provider
                  {cancellation.mode === "live" ? ". That also marks the subscription cancelled here" : ""}.
                </p>
              </div>
            ) : null}

            {cancellation.state === "failed" ? (
              <div className="border border-blood/30 bg-blood/[0.06] px-4 py-4">
                <div className="flex items-center gap-2">
                  <TriangleAlert size={15} className="text-blood" />
                  <span className="text-[13px] text-bone">The run failed.</span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
                  Nothing was charged and no token can be reused. Start over with a fresh authorization, or revoke and
                  handle this one yourself.
                </p>
              </div>
            ) : null}

            {cancellation.state === "revoked" ? (
              <div className="border border-line bg-raised/40 px-4 py-4">
                <div className="flex items-center gap-2">
                  <Ban size={15} className="text-muted" />
                  <span className="text-[13px] text-bone">Authorization revoked</span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
                  Nothing was sent and the subscription is untouched.
                </p>
              </div>
            ) : null}

            <Steps steps={cancellation.steps} />

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Fact label="State">{cancellation.state.replaceAll("_", " ")}</Fact>
              <Fact label="Mode">{cancellation.mode === "dry_run" ? "Rehearsal" : "Cancel"}</Fact>
              <Fact label="Effective">{formatDate(cancellation.effectiveDate, { withYear: true })}</Fact>
              <Fact label="Completed">
                {cancellation.completedAt ? formatDateTime(cancellation.completedAt) : "—"}
              </Fact>
            </div>

            <p className="font-mono text-[9px] uppercase leading-relaxed tracking-[0.12em] text-faint">
              Receipt {cancellation.id.slice(0, 8)}
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft px-6 py-4">
        <div className="flex items-center gap-2 font-mono text-[8px] uppercase tracking-[0.12em] text-faint">
          <Lock size={10} />
          Confirmation required before anything runs
        </div>
        <div className="flex items-center gap-2">
          {phase === "configure" ? (
            <>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Close
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void prepare()} disabled={busy}>
                {busy ? <Spinner /> : <ShieldCheck size={13} />}
                Prepare authorization
              </button>
            </>
          ) : null}

          {phase === "authorize" ? (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => void revoke()} disabled={busy || !cancellation}>
                Revoke draft
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void authorize()} disabled={!canAuthorize}>
                {busy ? <Spinner /> : <Lock size={13} />}
                Authorize cancellation
              </button>
            </>
          ) : null}

          {phase === "execute" ? (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => void revoke()} disabled={busy}>
                Revoke
              </button>
              {expired ? (
                <button type="button" className="btn" onClick={restart}>
                  <RotateCcw size={13} />
                  Start over
                </button>
              ) : (
                <button type="button" className="btn btn-danger" onClick={() => void execute()} disabled={busy || !token}>
                  {busy ? <Spinner /> : <ShieldCheck size={13} />}
                  Run cancellation
                </button>
              )}
            </>
          ) : null}

          {phase === "running" ? (
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close and let it finish
            </button>
          ) : null}

          {phase === "result" ? (
            <>
              {cancellation && ["requires_human", "failed"].includes(cancellation.state) ? (
                <button type="button" className="btn" onClick={restart}>
                  <RotateCcw size={13} />
                  Start over
                </button>
              ) : null}
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

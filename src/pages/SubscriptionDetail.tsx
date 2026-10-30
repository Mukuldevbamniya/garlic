import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Ban,
  CircleCheck,
  ExternalLink,
  Lock,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { useApp } from "../store.tsx";
import { api, useQuery } from "../lib/api.ts";
import type { Alert, Cancellation, Subscription } from "../../shared/types.ts";
import { annualCost, cadenceLabel, formatDate, formatDateTime, money, monthlyCost, percent, relativeDay } from "../lib/format.ts";
import { PageHeader, Panel, PanelHeader, SeverityDot, Spinner, StatusBadge } from "../components/ui.tsx";
import { CancellationPanel } from "../components/CancellationPanel.tsx";

interface DetailPayload {
  subscription: Subscription;
  evidence: Array<{
    id: string;
    postedAt: string;
    amountCents: number;
    currency: string;
    rawDescriptor: string;
    isPending: boolean;
    source: string;
  }>;
  alerts: Alert[];
  cancellations: Cancellation[];
}

interface Review {
  verdict: "likely_subscription" | "uncertain" | "not_subscription";
  confidence: number;
  reasoning: string[];
  cadenceAssessment: string;
  risks: string[];
}

const VERDICT_TONE: Record<Review["verdict"], { label: string; color: string; border: string; bg: string }> = {
  likely_subscription: { label: "Likely a subscription", color: "var(--color-acid)", border: "rgba(198,242,78,0.28)", bg: "rgba(198,242,78,0.06)" },
  uncertain: { label: "Uncertain", color: "var(--color-amber)", border: "rgba(255,176,46,0.28)", bg: "rgba(255,176,46,0.06)" },
  not_subscription: { label: "Probably not a subscription", color: "var(--color-blood)", border: "rgba(255,74,61,0.3)", bg: "rgba(255,74,61,0.06)" },
};

function Sparkline({ amounts }: { amounts: number[] }) {
  if (amounts.length < 2) return null;
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  const span = Math.max(1, max - min);
  const points = amounts.map((amount, index) => {
    const x = (index / (amounts.length - 1)) * 100;
    const y = 30 - ((amount - min) / span) * 26;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M ${points.join(" L ")}`;
  const area = `${line} L 100,32 L 0,32 Z`;
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-9 w-full" aria-hidden="true">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-acid)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--color-acid)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark-fill)" />
      <path d={line} fill="none" stroke="var(--color-acid)" strokeWidth="0.9" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function SubscriptionDetail() {
  const { id } = useParams<{ id: string }>();
  const { refresh, toast, state } = useApp();
  const query = useQuery<DetailPayload>(`/api/subscriptions/${id ?? ""}`);
  const [panelOpen, setPanelOpen] = useState(false);
  const [resume, setResume] = useState<Cancellation | undefined>(undefined);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [usedDraft, setUsedDraft] = useState("");

  const sub = query.data?.subscription;
  const evidence = query.data?.evidence ?? [];
  const alerts = query.data?.alerts ?? [];
  const cancellations = query.data?.cancellations ?? [];

  useEffect(() => {
    if (sub) {
      setNameDraft(sub.displayName);
      setUsedDraft(sub.lastUsedAt ?? "");
    }
  }, [sub?.id, sub?.displayName, sub?.lastUsedAt]);

  if (query.loading && !sub) {
    return (
      <div className="space-y-5">
        <div className="h-20 animate-pulse rounded-[2px] bg-surface" />
        <div className="grid gap-5 lg:grid-cols-12">
          <div className="h-96 animate-pulse rounded-[2px] bg-surface lg:col-span-8" />
          <div className="h-96 animate-pulse rounded-[2px] bg-surface lg:col-span-4" />
        </div>
      </div>
    );
  }

  if (query.error || !sub) {
    return (
      <Panel className="p-8">
        <div className="eyebrow mb-3 text-blood">Not found</div>
        <h1 className="text-[30px] leading-none">That subscription is not in the ledger.</h1>
        <p className="mt-3 max-w-[52ch] text-[13px] leading-relaxed text-muted">
          {query.error ?? "It may have been removed by a reset or wipe."}
        </p>
        <Link to="/subscriptions" className="btn mt-5">
          <ArrowLeft size={13} />
          Back to subscriptions
        </Link>
      </Panel>
    );
  }

  const canCancel = sub.status !== "cancelled" && sub.status !== "ignored";
  const maxWeight = Math.max(0.01, ...sub.reasons.map((reason) => Math.abs(reason.weight)));
  const chargeAmounts = evidence.filter((row) => row.amountCents > 0).map((row) => row.amountCents);

  const patch = async (body: Record<string, unknown>, message: string) => {
    setBusy(true);
    try {
      await api(`/api/subscriptions/${sub.id}`, { method: "PATCH", body: JSON.stringify(body) });
      await query.refresh();
      await refresh();
      toast(message, "ok");
      setRenaming(false);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Update failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const act = async (path: string, message: string) => {
    setBusy(true);
    try {
      await api(`/api/subscriptions/${sub.id}/${path}`, { method: "POST" });
      await query.refresh();
      await refresh();
      toast(message, "ok");
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Action failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const runReview = async () => {
    setReviewing(true);
    try {
      const result = await api<{ review: Review; note: string }>("/api/ai/review", {
        method: "POST",
        body: JSON.stringify({ subscriptionId: sub.id }),
      });
      setReview(result.review);
      setReviewNote(result.note);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Second opinion failed.", "error");
    } finally {
      setReviewing(false);
    }
  };

  const openPanel = (existing?: Cancellation) => {
    setResume(existing);
    setPanelOpen(true);
  };

  return (
    <div className="space-y-6">
      <Link
        to="/subscriptions"
        className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-faint transition-colors hover:text-bone"
      >
        <ArrowLeft size={11} />
        All subscriptions
      </Link>

      <PageHeader
        eyebrow={`${sub.category} · ${sub.merchantKey}`}
        title={sub.displayName}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <StatusBadge status={sub.status} />
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              {cadenceLabel(sub.cadence)} · {money(sub.amountCents, sub.currency)}
              {sub.nextChargeAt ? ` · renews ${relativeDay(sub.nextChargeAt)}` : " · no scheduled renewal"}
            </span>
          </span>
        }
        actions={
          <>
            {sub.status === "pending_review" ? (
              <>
                <button type="button" className="btn" onClick={() => void act("confirm", "Confirmed as a subscription.")} disabled={busy}>
                  <CircleCheck size={13} />
                  Confirm
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => void act("dismiss", "Dismissed. It will not be tracked.")} disabled={busy}>
                  <Ban size={13} />
                  Dismiss
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => openPanel()}
              disabled={!canCancel}
            >
              <ShieldCheck size={13} />
              {canCancel ? "Cancel subscription" : "Already stopped"}
            </button>
          </>
        }
      />

      {sub.priceChange ? (
        <div className="flex flex-wrap items-center gap-3 border border-amber/25 bg-amber/[0.04] px-4 py-3">
          {sub.priceChange.deltaPct > 0 ? (
            <TrendingUp size={15} className="text-amber" />
          ) : (
            <TrendingDown size={15} className="text-acid" />
          )}
          <span className="text-[12.5px] text-bone">
            Price {sub.priceChange.deltaPct > 0 ? "increased" : "decreased"} {Math.abs(sub.priceChange.deltaPct).toFixed(0)}% on{" "}
            {formatDate(sub.priceChange.at, { withYear: true })}
          </span>
          <span className="num text-[12px] text-muted">
            {money(sub.priceChange.fromCents, sub.currency)} → {money(sub.priceChange.toCents, sub.currency)}
          </span>
          <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
            {money(Math.abs(annualCost(sub) - annualCost({ ...sub, amountCents: sub.priceChange.fromCents })), sub.currency)} a
            year at the new price
          </span>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-8">
          <Panel>
            <PanelHeader
              eyebrow="Why the detector believes this"
              title="Confidence breakdown"
              action={
                <div className="flex items-baseline gap-2">
                  <span className="num text-[26px] leading-none text-bone">{percent(sub.confidence)}</span>
                  <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint">confidence</span>
                </div>
              }
            />
            <div className="space-y-0">
              {sub.reasons.map((reason) => {
                const positive = reason.weight > 0;
                const neutral = reason.weight === 0;
                const width = Math.max(4, (Math.abs(reason.weight) / maxWeight) * 100);
                return (
                  <div key={`${reason.code}-${reason.label}`} className="grid grid-cols-[1fr_90px] items-start gap-4 border-b border-line-soft px-5 py-3 last:border-b-0 sm:grid-cols-[190px_1fr_90px]">
                    <div className="min-w-0">
                      <div className="text-[12px] text-bone">{reason.label}</div>
                      <div className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-faint">{reason.code}</div>
                    </div>
                    <p className="hidden text-[11.5px] leading-relaxed text-muted sm:block">{reason.detail}</p>
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-[3px] w-10 overflow-hidden rounded-full bg-line">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${neutral ? 6 : width}%`,
                            background: neutral ? "var(--color-faint)" : positive ? "var(--color-acid)" : "var(--color-blood)",
                          }}
                        />
                      </div>
                      <span className={`num w-8 text-right text-[10px] ${neutral ? "text-faint" : positive ? "text-acid" : "text-blood"}`}>
                        {reason.weight > 0 ? "+" : ""}
                        {reason.weight.toFixed(2)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-5 py-3">
              <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint">Alternative fits</span>
              {sub.alternatives.length === 0 ? (
                <span className="text-[11px] text-muted">No close competitor cadence.</span>
              ) : (
                sub.alternatives.map((alt) => (
                  <span key={alt.cadence} className="chip">
                    {cadenceLabel(alt.cadence)} · {percent(alt.confidence)}
                  </span>
                ))
              )}
              {sub.needsReview ? (
                <span className="chip border-amber/30 text-amber">flagged for review</span>
              ) : (
                <span className="chip border-acid/25 text-acid">accepted</span>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              eyebrow={`${evidence.length} matching charges`}
              title="Charge history"
              action={
                <div className="text-right">
                  <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint">annualised</div>
                  <div className="num text-[13px] text-bone">{money(annualCost(sub), sub.currency)}</div>
                </div>
              }
            />
            {chargeAmounts.length > 1 ? (
              <div className="border-b border-line-soft px-5 pb-1 pt-3">
                <Sparkline amounts={chargeAmounts} />
                <div className="flex items-center justify-between font-mono text-[8px] uppercase tracking-[0.12em] text-faint">
                  <span>{formatDate(evidence[0]?.postedAt ?? null, { withYear: true })}</span>
                  <span>{formatDate(evidence[evidence.length - 1]?.postedAt ?? null, { withYear: true })}</span>
                </div>
              </div>
            ) : null}
            <div className="grid grid-cols-[100px_1fr_auto] gap-4 border-b border-line-soft px-5 py-2 font-mono text-[8px] uppercase tracking-[0.14em] text-faint">
              <span>Posted</span>
              <span>Statement descriptor</span>
              <span className="text-right">Amount</span>
            </div>
            <div className="max-h-[340px] overflow-y-auto">
              {evidence.map((row) => {
                const isLatest = row.postedAt === sub.lastSeen && row.amountCents === sub.amountCents;
                const changed = sub.priceChange?.at === row.postedAt;
                return (
                  <div
                    key={row.id}
                    className={`grid grid-cols-[100px_1fr_auto] items-center gap-4 border-b border-line-soft px-5 py-2.5 last:border-b-0 ${
                      changed ? "bg-amber/[0.04]" : ""
                    }`}
                  >
                    <span className="num text-[11px] text-muted">{formatDate(row.postedAt, { withYear: true })}</span>
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[10.5px] text-bone">{row.rawDescriptor}</div>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-[8px] uppercase tracking-[0.1em] text-faint">
                        <span>{row.source}</span>
                        {isLatest ? <span className="text-acid">latest</span> : null}
                        {changed ? <span className="text-amber">price change</span> : null}
                        {row.isPending ? <span className="text-amber">pending</span> : null}
                      </div>
                    </div>
                    <span className={`num text-right text-[12px] ${changed ? "text-amber" : "text-bone"}`}>
                      {money(row.amountCents, sub.currency)}
                    </span>
                  </div>
                );
              })}
            </div>
          </Panel>

          {cancellations.length > 0 ? (
            <Panel>
              <PanelHeader eyebrow="Agent history" title="Cancellation attempts" />
              {cancellations.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center gap-3 border-b border-line-soft px-5 py-3.5 last:border-b-0">
                  <span
                    className={`inline-flex h-[21px] items-center gap-1.5 border px-2 font-mono text-[9px] uppercase tracking-[0.1em] ${
                      item.state === "cancelled"
                        ? "border-acid/30 bg-acid/[0.06] text-acid"
                        : item.state === "requires_human"
                          ? "border-amber/30 bg-amber/[0.06] text-amber"
                          : item.state === "failed" || item.state === "revoked"
                            ? "border-blood/25 bg-blood/[0.05] text-blood"
                            : "border-line text-muted"
                    }`}
                  >
                    {item.state.replaceAll("_", " ")}
                  </span>
                  <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
                    {item.mode === "dry_run" ? "rehearsal" : "cancelled"} · {formatDateTime(item.createdAt)}
                  </span>
                  <span className="hidden font-mono text-[9px] uppercase tracking-[0.1em] text-faint sm:inline">
                    {item.steps.filter((step) => step.status === "done").length}/{item.steps.length} steps
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost ml-auto h-7 px-2 text-[10px]"
                    onClick={() => openPanel(item)}
                  >
                    {item.state === "requires_human" ? "Finish handover" : "Open"}
                  </button>
                </div>
              ))}
            </Panel>
          ) : null}
        </div>

        <div className="space-y-5 lg:col-span-4">
          <Panel>
            <PanelHeader eyebrow="Plan facts" title="Next charge" />
            <div className="px-5 py-4">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="num text-[30px] leading-none text-bone">{money(sub.amountCents, sub.currency)}</div>
                  <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
                    {cadenceLabel(sub.cadence)} · {money(monthlyCost(sub), sub.currency)}/mo equivalent
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-faint">next</div>
                  <div className="text-[13px] text-bone">{formatDate(sub.nextChargeAt, { withYear: true })}</div>
                  <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-amber">{relativeDay(sub.nextChargeAt)}</div>
                </div>
              </div>
              <div className="mt-4 space-y-0 divide-y divide-line-soft border-t border-line-soft">
                {[
                  ["Annual cost", money(annualCost(sub), sub.currency)],
                  ["Billing model", sub.billingModel === "variable" ? "Variable / usage-based" : "Fixed"],
                  ["Charges seen", `${sub.occurrences} since ${formatDate(sub.firstSeen, { withYear: true })}`],
                  ["Last charge", formatDate(sub.lastSeen, { withYear: true })],
                  ["Last used", sub.lastUsedAt ? `${formatDate(sub.lastUsedAt, { withYear: true })} · ${relativeDay(sub.lastUsedAt)}` : "No usage signal"],
                  ["Notice period", sub.noticePeriodDays > 0 ? `${sub.noticePeriodDays} days` : "None"],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="text-[11.5px] text-muted">{label}</span>
                    <span className="text-right text-[11.5px] text-bone">{value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t border-line-soft px-5 py-3.5">
              <div className="eyebrow mb-1.5">Cancellation route</div>
              <div className="flex items-center gap-2 text-[12px] text-bone">
                <Lock size={12} className="text-faint" />
                {sub.cancellationChannel.replaceAll("_", " ")}
              </div>
              {sub.cancellationUrl ? (
                <a
                  href={sub.cancellationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-muted hover:text-acid"
                >
                  Official page <ExternalLink size={10} />
                </a>
              ) : null}
              {sub.tosNote ? <p className="mt-2 text-[11px] leading-relaxed text-faint">{sub.tosNote}</p> : null}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              eyebrow={state?.ai.configured && state.ai.enabled ? `${state.ai.provider}/${state.ai.model}` : "local heuristics"}
              title="AI second opinion"
              action={
                <button type="button" className="btn h-7 px-2.5 text-[11px]" onClick={() => void runReview()} disabled={reviewing}>
                  {reviewing ? <Spinner /> : <Sparkles size={12} />}
                  {review ? "Refresh" : "Review"}
                </button>
              }
            />
            {review ? (
              <div className="space-y-3 px-5 py-4">
                <span
                  className="inline-flex h-[22px] items-center border px-2 font-mono text-[9px] uppercase tracking-[0.1em]"
                  style={{
                    color: VERDICT_TONE[review.verdict].color,
                    borderColor: VERDICT_TONE[review.verdict].border,
                    background: VERDICT_TONE[review.verdict].bg,
                  }}
                >
                  {VERDICT_TONE[review.verdict].label}
                </span>
                <p className="text-[11.5px] leading-relaxed text-muted">{review.cadenceAssessment}</p>
                <ul className="space-y-1.5">
                  {review.reasoning.map((line) => (
                    <li key={line} className="flex gap-2 text-[11px] leading-relaxed text-muted">
                      <span className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-faint" />
                      {line}
                    </li>
                  ))}
                </ul>
                {review.risks.length > 0 ? (
                  <div className="border border-amber/25 bg-amber/[0.04] px-3 py-2">
                    {review.risks.map((risk) => (
                      <p key={risk} className="flex gap-1.5 text-[10.5px] leading-relaxed text-amber">
                        <TriangleAlert size={11} className="mt-0.5 shrink-0" />
                        {risk}
                      </p>
                    ))}
                  </div>
                ) : null}
                {reviewNote ? <p className="font-mono text-[8px] uppercase leading-relaxed tracking-[0.1em] text-faint">{reviewNote}</p> : null}
              </div>
            ) : (
              <div className="px-5 py-4">
                <p className="text-[11.5px] leading-relaxed text-muted">
                  Ask a skeptical second opinion whether this is really a recurring subscription. It sees only the
                  evidence on this page — never raw account numbers.
                </p>
                {!state?.ai.configured ? (
                  <p className="mt-2 font-mono text-[8px] uppercase leading-relaxed tracking-[0.1em] text-faint">
                    No key configured · deterministic breakdown
                  </p>
                ) : null}
              </div>
            )}
          </Panel>

          <Panel>
            <PanelHeader eyebrow="Alerts" title={`${alerts.filter((alert) => alert.status !== "resolved").length} open`} />
            {alerts.length === 0 ? (
              <div className="px-5 py-4 text-[11.5px] leading-relaxed text-muted">
                No alerts for this subscription. Renewals and price changes will appear here.
              </div>
            ) : (
              <div>
                {alerts.slice(0, 4).map((alert) => (
                  <div key={alert.id} className="border-b border-line-soft px-5 py-3 last:border-b-0">
                    <div className="flex items-start gap-2">
                      <span className="mt-[6px]">
                        <SeverityDot severity={alert.severity} />
                      </span>
                      <div className="min-w-0">
                        <div className="text-[11.5px] leading-snug text-bone">{alert.title}</div>
                        <div className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-faint">
                          {alert.status} · {alert.kind.replaceAll("_", " ")}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel>
            <PanelHeader eyebrow="Control" title="Manage this entry" />
            <div className="space-y-4 px-5 py-4">
              <div>
                <div className="eyebrow mb-1.5">Display name</div>
                {renaming ? (
                  <div className="flex gap-2">
                    <input
                      className="input"
                      value={nameDraft}
                      onChange={(event) => setNameDraft(event.target.value)}
                      aria-label="Display name"
                      autoFocus
                    />
                    <button
                      type="button"
                      className="btn btn-primary h-9 px-3"
                      onClick={() => void patch({ displayName: nameDraft.trim() }, "Name updated.")}
                      disabled={busy || nameDraft.trim().length === 0}
                    >
                      Save
                    </button>
                    <button type="button" className="btn btn-ghost h-9 px-2" onClick={() => setRenaming(false)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] text-bone">{sub.displayName}</span>
                    <button type="button" className="btn btn-ghost h-7 px-2 text-[10px]" onClick={() => setRenaming(true)}>
                      <Pencil size={11} />
                      Rename
                    </button>
                  </div>
                )}
              </div>

              <div>
                <div className="eyebrow mb-1.5">Last used</div>
                <div className="flex gap-2">
                  <input
                    type="date"
                    className="input h-9"
                    value={usedDraft}
                    onChange={(event) => setUsedDraft(event.target.value)}
                    aria-label="Last used date"
                  />
                  <button
                    type="button"
                    className="btn h-9 px-3"
                    onClick={() => void patch({ lastUsedAt: usedDraft || null }, "Usage date saved.")}
                    disabled={busy}
                  >
                    Save
                  </button>
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-faint">
                  Drives the dormant-subscription signal. Clear it to remove the usage claim.
                </p>
              </div>

              <div className="flex flex-wrap gap-2 border-t border-line-soft pt-3">
                <button
                  type="button"
                  className="btn btn-ghost h-8 px-2.5 text-[11px]"
                  onClick={() => void act("confirm", "Confirmed as a subscription.")}
                  disabled={busy}
                >
                  <CircleCheck size={12} />
                  Confirm
                </button>
                <button
                  type="button"
                  className="btn btn-ghost h-8 px-2.5 text-[11px]"
                  onClick={() => void act("dismiss", "Marked as not a subscription.")}
                  disabled={busy}
                >
                  <Ban size={12} />
                  Not a subscription
                </button>
                <button
                  type="button"
                  className="btn btn-ghost ml-auto h-8 px-2.5 text-[11px]"
                  onClick={() => {
                    void query.refresh();
                    void refresh();
                  }}
                >
                  <RefreshCw size={12} />
                  Refresh
                </button>
              </div>
            </div>
          </Panel>
        </div>
      </div>

      <CancellationPanel
        subscription={sub}
        open={panelOpen}
        resume={resume}
        onClose={() => {
          setPanelOpen(false);
          setResume(undefined);
          void query.refresh();
          void refresh();
        }}
        onChanged={() => {
          void query.refresh();
          void refresh();
        }}
      />

      {cancellations.some((item) => item.state === "requires_human") ? (
        <div className="flex flex-wrap items-center gap-3 border border-amber/25 bg-amber/[0.04] px-4 py-3">
          <TriangleAlert size={14} className="text-amber" />
          <span className="text-[12px] text-bone">A cancellation is waiting on your handover.</span>
          <button
            type="button"
            className="btn ml-auto h-7 px-2.5 text-[10px]"
            onClick={() => {
              const pending = cancellations.find((item) => item.state === "requires_human");
              if (pending) openPanel(pending);
            }}
          >
            Finish it
          </button>
        </div>
      ) : null}

      {cancellations.length === 0 && sub.status !== "cancelled" ? (
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
          <Lock size={10} />
          Cancellation requires a typed confirmation
        </div>
      ) : null}
    </div>
  );
}

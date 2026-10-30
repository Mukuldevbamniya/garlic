import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  BellRing,
  CalendarClock,
  Check,
  ChevronRight,
  RefreshCw,
  Skull,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useApp } from "../store.tsx";
import { api, useQuery } from "../lib/api.ts";
import type { Alert, AlertKind, AlertSeverity } from "../../shared/types.ts";
import { formatDate, formatDateTime, relativeDay } from "../lib/format.ts";
import { Empty, PageHeader, Panel, SeverityDot, Spinner } from "../components/ui.tsx";

type Filter = "attention" | "critical" | "warning" | "info" | "snoozed" | "resolved";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "attention", label: "Needs attention" },
  { key: "critical", label: "Critical" },
  { key: "warning", label: "Warning" },
  { key: "info", label: "Info" },
  { key: "snoozed", label: "Snoozed" },
  { key: "resolved", label: "Resolved" },
];

const SEVERITY_ORDER: AlertSeverity[] = ["critical", "warning", "info"];

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Informational",
};

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  critical: "var(--color-blood)",
  warning: "var(--color-amber)",
  info: "var(--color-faint)",
};

const KIND_LABEL: Record<AlertKind, string> = {
  renewal: "Renewal",
  price_increase: "Price increase",
  trial_ending: "Trial ending",
  annual_renewal: "Annual renewal",
  duplicate_service: "Overlapping service",
  failed_charge: "Failed charge",
  zombie: "Dormant plan",
};

function KindIcon({ kind }: { kind: AlertKind }) {
  if (kind === "zombie") return <Skull size={11} />;
  if (kind === "price_increase") return <Zap size={11} />;
  if (kind === "renewal" || kind === "annual_renewal" || kind === "trial_ending") return <CalendarClock size={11} />;
  if (kind === "duplicate_service") return <BellRing size={11} />;
  return <TriangleAlert size={11} />;
}

function AlertRow({
  alert,
  busy,
  onAction,
}: {
  alert: Alert;
  busy: boolean;
  onAction: (alert: Alert, action: "read" | "resolve" | "snooze", days?: number) => void;
}) {
  const settled = alert.status === "resolved";
  return (
    <div className="group relative flex flex-col gap-3 border-b border-line-soft px-5 py-4 last:border-b-0 sm:flex-row sm:items-start">
      <span
        className="absolute left-0 top-0 h-full w-[2px] opacity-70"
        style={{ background: SEVERITY_COLOR[alert.severity] }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <SeverityDot severity={alert.severity} />
          <span className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-faint">
            {KIND_LABEL[alert.kind]}
          </span>
          {alert.subscriptionName ? (
            <>
              <span className="text-faint">·</span>
              <span className="truncate text-[10px] uppercase tracking-[0.08em] text-muted">{alert.subscriptionName}</span>
            </>
          ) : null}
          {alert.status === "snoozed" && alert.snoozedUntil ? (
            <span className="chip border-line text-faint">snoozed to {formatDate(alert.snoozedUntil)}</span>
          ) : null}
          {settled ? <span className="chip border-line text-faint">resolved</span> : null}
        </div>

        <h3 className={`mt-1.5 text-[13.5px] leading-snug ${settled ? "text-muted" : "text-bone"}`}>{alert.title}</h3>
        <p className="mt-1 max-w-[76ch] text-[11.5px] leading-relaxed text-muted">{alert.body}</p>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[8.5px] uppercase tracking-[0.1em] text-faint">
          <span className="inline-flex items-center gap-1">
            <KindIcon kind={alert.kind} />
            {alert.kind.replaceAll("_", " ")}
          </span>
          {alert.dueAt ? (
            <span className={relativeDay(alert.dueAt).includes("ago") ? "text-amber" : ""}>
              due {formatDate(alert.dueAt, { withYear: true })} · {relativeDay(alert.dueAt)}
            </span>
          ) : null}
          <span>raised {formatDateTime(alert.createdAt)}</span>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:flex-col sm:items-stretch">
        {alert.subscriptionId ? (
          <Link
            to={`/subscriptions/${alert.subscriptionId}`}
            className="btn h-7 justify-between px-2.5 text-[10.5px] sm:w-[132px]"
          >
            Open plan
            <ChevronRight size={11} />
          </Link>
        ) : null}

        {!settled ? (
          <div className="flex items-center gap-1.5">
            {alert.status === "open" ? (
              <button
                type="button"
                className="btn btn-ghost h-7 px-2 text-[10.5px]"
                onClick={() => onAction(alert, "read")}
                disabled={busy}
                title="Mark as read"
              >
                <Check size={11} />
                Read
              </button>
            ) : null}
            <select
              className="input h-7 w-[112px] cursor-pointer px-1.5 font-mono text-[9px] uppercase tracking-[0.06em]"
              value=""
              disabled={busy}
              onChange={(event) => {
                const days = Number(event.target.value);
                if (days > 0) onAction(alert, "snooze", days);
                event.target.value = "";
              }}
              aria-label={`Snooze ${alert.title}`}
            >
              <option value="">Snooze…</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
            </select>
          </div>
        ) : null}

        {alert.status !== "resolved" ? (
          <button
            type="button"
            className="btn btn-ghost h-7 px-2 text-[10.5px]"
            onClick={() => onAction(alert, "resolve")}
            disabled={busy}
          >
            {busy ? <Spinner /> : <Check size={11} />}
            Resolve
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Alerts() {
  const { state, refresh, toast } = useApp();
  const query = useQuery<{ alerts: Alert[] }>("/api/alerts");
  const [filter, setFilter] = useState<Filter>("attention");
  const [busyId, setBusyId] = useState<string | null>(null);

  const alerts = query.data?.alerts ?? [];

  const counts = useMemo(() => {
    const map = new Map<Filter, number>([
      ["attention", alerts.filter((alert) => alert.status === "open" || alert.status === "read").length],
      ["critical", alerts.filter((alert) => alert.severity === "critical" && alert.status !== "resolved").length],
      ["warning", alerts.filter((alert) => alert.severity === "warning" && alert.status !== "resolved").length],
      ["info", alerts.filter((alert) => alert.severity === "info" && alert.status !== "resolved").length],
      ["snoozed", alerts.filter((alert) => alert.status === "snoozed").length],
      ["resolved", alerts.filter((alert) => alert.status === "resolved").length],
    ]);
    return map;
  }, [alerts]);

  const visible = useMemo(() => {
    const matches = (alert: Alert): boolean => {
      if (filter === "attention") return alert.status === "open" || alert.status === "read";
      if (filter === "snoozed") return alert.status === "snoozed";
      if (filter === "resolved") return alert.status === "resolved";
      return alert.status !== "resolved" && alert.severity === filter;
    };
    const rows = alerts.filter(matches);
    if (filter === "resolved" || filter === "snoozed") {
      return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return rows;
  }, [alerts, filter]);

  const groups = useMemo(() => {
    if (filter === "snoozed" || filter === "resolved") return [{ severity: null as AlertSeverity | null, rows: visible }];
    return SEVERITY_ORDER.map((severity) => ({
      severity,
      rows: visible.filter((alert) => alert.severity === severity),
    })).filter((group) => group.rows.length > 0);
  }, [filter, visible]);

  const mutate = async (alert: Alert, action: "read" | "resolve" | "snooze", days?: number) => {
    setBusyId(alert.id);
    try {
      await api(`/api/alerts/${alert.id}/${action}`, {
        method: "POST",
        body: action === "snooze" ? JSON.stringify({ days: days ?? 3 }) : undefined,
      });
      await query.refresh();
      await refresh();
      if (action === "resolve") toast("Alert resolved.", "ok");
      if (action === "snooze") toast(`Snoozed for ${days ?? 3} days.`, "ok");
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Could not update the alert.", "error");
    } finally {
      setBusyId(null);
    }
  };

  const critical = counts.get("critical") ?? 0;
  const warning = counts.get("warning") ?? 0;
  const info = counts.get("info") ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Decision queue"
        title="Alerts"
        description={
          <>
            Renewals, price moves, overlapping services, and plans that stopped being used. Resolve or snooze each one —
            nothing is cancelled from here.
          </>
        }
        actions={
          <button type="button" className="btn" onClick={() => void query.refresh()} disabled={query.loading}>
            <RefreshCw size={13} className={query.loading ? "animate-spin" : ""} />
            Refresh
          </button>
        }
      />

      <Panel className="grid grid-cols-3 divide-x divide-line-soft">
        {(
          [
            { label: "Critical", value: critical, color: "text-blood", note: "act before renewal" },
            { label: "Warning", value: warning, color: "text-amber", note: "worth a look" },
            { label: "Informational", value: info, color: "text-muted", note: "context only" },
          ] as const
        ).map((item) => (
          <div key={item.label} className="px-5 py-4">
            <div className="eyebrow mb-2">{item.label}</div>
            <div className={`num text-[28px] leading-none ${item.color}`}>{item.value}</div>
            <div className="mt-1.5 font-mono text-[8.5px] uppercase tracking-[0.1em] text-faint">{item.note}</div>
          </div>
        ))}
      </Panel>

      <div className="flex flex-wrap gap-1 border border-line-soft bg-surface p-1">
        {FILTERS.map((item) => {
          const count = counts.get(item.key) ?? 0;
          const active = filter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              className={`flex items-center gap-1.5 rounded-[2px] px-2.5 py-1.5 text-[11.5px] transition-colors ${
                active ? "bg-raised text-bone" : "text-muted hover:text-bone"
              }`}
            >
              {item.label}
              <span className={`num text-[9px] ${active ? "text-faint" : "text-faint/60"}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {query.loading ? (
        <div className="space-y-3">
          <div className="h-28 animate-pulse rounded-[2px] bg-surface" />
          <div className="h-28 animate-pulse rounded-[2px] bg-surface" />
          <div className="h-28 animate-pulse rounded-[2px] bg-surface" />
        </div>
      ) : query.error ? (
        <Panel className="p-8">
          <div className="eyebrow mb-2 text-blood">Could not load alerts</div>
          <p className="text-[13px] text-muted">{query.error}</p>
        </Panel>
      ) : visible.length === 0 ? (
        <Panel>
          <Empty
            icon={<BellRing size={20} />}
            title={filter === "resolved" ? "Nothing resolved yet" : "Queue is clear"}
            body={
              filter === "resolved"
                ? "Resolved alerts stay in this list. There are none yet."
                : filter === "snoozed"
                  ? "Nothing is snoozed. Snoozed alerts return to this queue on their own."
                  : state?.counts.transactions === 0
                    ? "Import a statement first. Renewal alerts appear after Garlic finds recurring charges."
                    : "No renewals, price changes, overlaps, or dormant plans need a decision right now."
            }
            action={
              state?.counts.transactions === 0 ? (
                <Link to="/import" className="btn">
                  Import a statement
                </Link>
              ) : (
                <Link to="/subscriptions" className="btn">
                  Browse subscriptions
                </Link>
              )
            }
          />
        </Panel>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.severity ?? filter}>
              {group.severity ? (
                <div className="mb-2 flex items-center gap-2.5">
                  <span className="h-[5px] w-[5px] rounded-full" style={{ background: SEVERITY_COLOR[group.severity] }} />
                  <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-faint">
                    {SEVERITY_LABEL[group.severity]}
                  </span>
                  <span className="h-px flex-1 bg-line-soft" />
                  <span className="num font-mono text-[9px] text-faint">{group.rows.length}</span>
                </div>
              ) : null}
              <Panel>
                {group.rows.map((alert) => (
                  <AlertRow
                    key={alert.id}
                    alert={alert}
                    busy={busyId === alert.id}
                    onAction={(target, action, days) => void mutate(target, action, days)}
                  />
                ))}
              </Panel>
            </section>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-4">
        <p className="max-w-[62ch] text-[11px] leading-relaxed text-faint">
          Alerts come from the ledger on every scan. Snoozing hides one until the date you choose. Resolving closes it.
        </p>
        <Link
          to="/subscriptions"
          className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-muted hover:text-bone"
        >
          Review all subscriptions
          <ArrowUpRight size={11} />
        </Link>
      </div>
    </div>
  );
}

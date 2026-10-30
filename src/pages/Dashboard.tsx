import { Link } from "react-router-dom";
import { ArrowUpRight, ChevronRight, RefreshCw, Skull } from "lucide-react";
import { useApp } from "../store.tsx";
import { useQuery } from "../lib/api.ts";
import type { Alert, Subscription } from "../../shared/types.ts";
import { annualCost, cadenceLabel, daysUntil, formatDate, formatDateTime, money, relativeDay } from "../lib/format.ts";
import { Empty, Meter, PageHeader, Panel, PanelHeader, SeverityDot, Stat } from "../components/ui.tsx";

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="h-24 animate-pulse rounded-[2px] bg-surface" />
      <div className="h-36 animate-pulse rounded-[2px] bg-surface" />
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="h-80 animate-pulse rounded-[2px] bg-surface lg:col-span-7" />
        <div className="h-80 animate-pulse rounded-[2px] bg-surface lg:col-span-5" />
      </div>
    </div>
  );
}

export function Dashboard() {
  const { state, loading, error, refresh, scan, scanning } = useApp();
  const subscriptionsQuery = useQuery<{ subscriptions: Subscription[] }>("/api/subscriptions");
  const alertsQuery = useQuery<{ alerts: Alert[] }>("/api/alerts");

  if (loading && !state) return <Skeleton />;

  if (error && !state) {
    return (
      <Panel className="p-8">
        <div className="eyebrow mb-3 text-blood">API unreachable</div>
        <h1 className="text-[30px] leading-none">The ledger cannot be reached.</h1>
        <p className="mt-3 max-w-[52ch] text-[13px] leading-relaxed text-muted">{error}</p>
        <button type="button" className="btn mt-5" onClick={() => void refresh()}>
          <RefreshCw size={13} />
          Try again
        </button>
      </Panel>
    );
  }

  if (!state) return null;

  const dateLine = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());

  if (state.counts.transactions === 0) {
    return (
      <div className="space-y-7">
        <PageHeader
          eyebrow={`Ledger · ${dateLine}`}
          title="Start with a statement."
          description="Import a bank or card CSV. Garlic finds recurring charges, warns you before they renew, and prepares a cancellation only after you authorize it."
        />
        <Panel>
          <Empty
            title="The ledger is empty"
            body="No transactions are stored yet. Import a statement and the detector will build your subscription list from it."
            action={
              <Link to="/import" className="btn btn-primary">
                Import a statement
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  const subscriptions = subscriptionsQuery.data?.subscriptions ?? [];
  const alerts = (alertsQuery.data?.alerts ?? []).filter((alert) => alert.status === "open" || alert.status === "read");
  const active = subscriptions.filter((sub) => sub.status === "active" || sub.status === "pending_review");
  const upcoming = active
    .filter((sub) => {
      const days = daysUntil(sub.nextChargeAt);
      return days !== null && days >= 0 && days <= 14;
    })
    .sort((a, b) => (a.nextChargeAt ?? "").localeCompare(b.nextChargeAt ?? ""));
  const upcomingTotal = upcoming.reduce((sum, sub) => sum + sub.amountCents, 0);
  const zombies = active
    .filter((sub) => sub.lastUsedAt !== null && (daysUntil(sub.lastUsedAt) ?? 0) <= -60)
    .sort((a, b) => annualCost(b) - annualCost(a));
  const zombieTotal = zombies.reduce((sum, sub) => sum + annualCost(sub), 0);
  const largest = [...active].sort((a, b) => annualCost(b) - annualCost(a)).slice(0, 8);

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow={`Ledger · ${dateLine}`}
        title="The quiet bleed."
        description={
          <>
            {active.length} subscriptions are siphoning{" "}
            <span className="text-bone">{money(state.stats.monthlyRecurringCents)}</span> a month —{" "}
            <span className="text-bone">{money(state.stats.annualRecurringCents)}</span> a year.{" "}
            {zombies.length > 0
              ? `${zombies.length} of them have gone unused for at least 60 days.`
              : "Nothing looks dormant right now."}
          </>
        }
        actions={
          <>
            <div className="hidden text-right sm:block">
              <div className="eyebrow">Last scan</div>
              <div className="mt-1 font-mono text-[11px] text-muted">
                {state.lastDetectedAt ? formatDateTime(state.lastDetectedAt) : "never"}
              </div>
            </div>
            <button type="button" className="btn" onClick={() => void scan()} disabled={scanning}>
              <RefreshCw size={13} className={scanning ? "animate-spin" : ""} />
              {scanning ? "Scanning" : "Scan now"}
            </button>
          </>
        }
      />

      <Panel className="grid grid-cols-2 divide-line-soft lg:grid-cols-4 lg:divide-x">
        <div className="border-b border-line-soft p-5 lg:border-b-0 lg:p-6">
          <Stat
            label="Monthly drain"
            value={money(state.stats.monthlyRecurringCents)}
            detail={`${active.length} active subscriptions`}
            size="lg"
          />
        </div>
        <div className="border-b border-line-soft p-5 lg:border-b-0 lg:p-6">
          <Stat
            label="Annualised"
            value={money(state.stats.annualRecurringCents)}
            detail="At today's cadence and prices"
            size="lg"
          />
        </div>
        <div className="border-r border-line-soft p-5 lg:border-r-0 lg:p-6">
          <Stat
            label="Recoverable"
            value={money(state.stats.potentialSavingsCents)}
            detail="Dormant plans and overlaps"
            accent="acid"
            size="lg"
          />
        </div>
        <div className="p-5 lg:p-6">
          <Stat
            label="Next 30 days"
            value={money(state.stats.next30DaysCents)}
            detail="Scheduled charges"
            accent="amber"
            size="lg"
          />
        </div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-12">
        <Panel className="lg:col-span-7">
          <PanelHeader
            eyebrow="Forward view"
            title="The next 14 days"
            action={
              <div className="text-right">
                <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-faint">scheduled</div>
                <div className="num text-[14px] text-bone">{money(upcomingTotal)}</div>
              </div>
            }
          />
          {upcoming.length === 0 ? (
            <Empty
              title="No charges in the next two weeks"
              body="Either this is a quiet fortnight or the statement import is behind. Import a fresher CSV to be sure."
              action={
                <Link to="/import" className="btn">
                  Import a statement
                </Link>
              }
            />
          ) : (
            <div>
              {upcoming.slice(0, 7).map((sub) => (
                <Link
                  key={sub.id}
                  to={`/subscriptions/${sub.id}`}
                  className="row-hover flex items-center gap-4 border-b border-line-soft px-5 py-3 last:border-b-0"
                >
                  <div className="w-11 shrink-0 border-r border-line-soft pr-3 text-right">
                    <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-faint">
                      {new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(
                        new Date(`${sub.nextChargeAt}T00:00:00Z`),
                      )}
                    </div>
                    <div className="num mt-0.5 text-[18px] leading-none text-bone">
                      {sub.nextChargeAt?.slice(8, 10)}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-bone">{sub.displayName}</div>
                    <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
                      {cadenceLabel(sub.cadence)} · {relativeDay(sub.nextChargeAt)}
                    </div>
                  </div>
                  <div className="num shrink-0 text-[13px] text-bone">{money(sub.amountCents, sub.currency)}</div>
                  <ChevronRight size={13} className="shrink-0 text-faint" />
                </Link>
              ))}
              {upcoming.length > 7 ? (
                <Link
                  to="/subscriptions"
                  className="flex items-center justify-between border-t border-line-soft px-5 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted hover:text-bone"
                >
                  <span>{upcoming.length - 7} more charges this fortnight</span>
                  <ArrowUpRight size={12} />
                </Link>
              ) : null}
            </div>
          )}
        </Panel>

        <Panel className="lg:col-span-5">
          <PanelHeader
            eyebrow="Decision queue"
            title="Needs a decision"
            action={
              <Link to="/alerts" className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted hover:text-bone">
                All {state.counts.openAlerts}
              </Link>
            }
          />
          {alerts.length === 0 ? (
            <Empty title="Queue is clear" body="No renewals, price changes, or dormant plans need attention right now." />
          ) : (
            <div>
              {alerts.slice(0, 5).map((alert) => (
                <Link
                  key={alert.id}
                  to={alert.subscriptionId ? `/subscriptions/${alert.subscriptionId}` : "/alerts"}
                  className="row-hover block border-b border-line-soft px-5 py-3.5 last:border-b-0"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="mt-[6px]">
                      <SeverityDot severity={alert.severity} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] leading-snug text-bone">{alert.title}</div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted">{alert.body}</p>
                      <div className="mt-1.5 font-mono text-[8px] uppercase tracking-[0.12em] text-faint">
                        {alert.kind.replaceAll("_", " ")}
                        {alert.dueAt ? ` · ${formatDate(alert.dueAt)}` : ""}
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-12">
        <Panel className="lg:col-span-7">
          <PanelHeader
            eyebrow="Ranked by annual cost"
            title="Largest recurring charges"
            action={
              <Link to="/subscriptions" className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted hover:text-bone">
                View all
              </Link>
            }
          />
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-line-soft px-5 py-2 font-mono text-[8px] uppercase tracking-[0.14em] text-faint sm:grid-cols-[1fr_auto_auto_auto]">
            <span>Merchant</span>
            <span className="hidden sm:block">Cadence</span>
            <span className="text-right">Per year</span>
            <span className="text-right">Conf.</span>
          </div>
          {largest.map((sub) => (
            <Link
              key={sub.id}
              to={`/subscriptions/${sub.id}`}
              className="row-hover grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-line-soft px-5 py-2.5 last:border-b-0 sm:grid-cols-[1fr_auto_auto_auto]"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line bg-raised font-mono text-[8px] text-muted">
                  {sub.displayName.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] text-bone">{sub.displayName}</div>
                  <div className="truncate font-mono text-[8px] uppercase tracking-[0.1em] text-faint">{sub.category}</div>
                </div>
              </div>
              <span className="hidden font-mono text-[10px] text-muted sm:block">{cadenceLabel(sub.cadence)}</span>
              <span className="num text-right text-[12.5px] text-bone">{money(annualCost(sub), sub.currency)}</span>
              <div className="hidden justify-end sm:flex">
                <Meter value={sub.confidence} />
              </div>
            </Link>
          ))}
        </Panel>

        <Panel className="lg:col-span-5">
          <PanelHeader
            eyebrow="Paid but unused"
            title="Dormant subscriptions"
            action={
              zombies.length > 0 ? (
                <span className="num text-[12px] text-acid">{money(zombieTotal)}/yr</span>
              ) : null
            }
          />
          {zombies.length === 0 ? (
            <Empty
              icon={<Skull size={20} />}
              title="No zombies"
              body="Every active subscription has been used within the last 60 days. Suspiciously healthy."
            />
          ) : (
            <div>
              {zombies.map((sub) => (
                <Link
                  key={sub.id}
                  to={`/subscriptions/${sub.id}`}
                  className="row-hover flex items-center gap-3 border-b border-line-soft px-5 py-3.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-bone">{sub.displayName}</div>
                    <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
                      unused {Math.abs(daysUntil(sub.lastUsedAt) ?? 0)} days
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="num text-[12.5px] text-acid">{money(annualCost(sub), sub.currency)}</div>
                    <div className="font-mono text-[8px] uppercase tracking-[0.1em] text-faint">per year</div>
                  </div>
                  <ChevronRight size={13} className="text-faint" />
                </Link>
              ))}
            </div>
          )}
          <div className="border-t border-line-soft px-5 py-3">
            <Link
              to="/alerts"
              className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.1em] text-muted hover:text-bone"
            >
              <span>Review the savings queue</span>
              <ArrowUpRight size={12} />
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}

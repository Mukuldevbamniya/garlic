import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { useApp } from "../store.tsx";
import { useQuery } from "../lib/api.ts";
import type { Subscription, SubscriptionStatus } from "../../shared/types.ts";
import { annualCost, cadenceLabel, formatDate, money, relativeDay } from "../lib/format.ts";
import { Empty, Meter, PageHeader, Panel, StatusBadge } from "../components/ui.tsx";

type Filter = SubscriptionStatus | "all";
type Sort = "annual" | "next" | "name" | "confidence";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "pending_review", label: "Review" },
  { key: "lapsed", label: "Lapsed" },
  { key: "cancelled", label: "Cancelled" },
  { key: "ignored", label: "Ignored" },
];

export function Subscriptions() {
  const { state, scan, scanning } = useApp();
  const query = useQuery<{ subscriptions: Subscription[] }>("/api/subscriptions");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("annual");
  const [search, setSearch] = useState("");

  const all = query.data?.subscriptions ?? [];
  const counts = useMemo(() => {
    const map = new Map<Filter, number>([["all", all.length]]);
    for (const sub of all) map.set(sub.status, (map.get(sub.status) ?? 0) + 1);
    return map;
  }, [all]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = all.filter((sub) => {
      if (filter !== "all" && sub.status !== filter) return false;
      if (!needle) return true;
      return (
        sub.displayName.toLowerCase().includes(needle) ||
        sub.category.toLowerCase().includes(needle) ||
        sub.merchantKey.toLowerCase().includes(needle)
      );
    });
    return filtered.sort((a, b) => {
      if (sort === "name") return a.displayName.localeCompare(b.displayName);
      if (sort === "confidence") return b.confidence - a.confidence;
      if (sort === "next") {
        if (a.nextChargeAt === null) return 1;
        if (b.nextChargeAt === null) return -1;
        return a.nextChargeAt.localeCompare(b.nextChargeAt);
      }
      return annualCost(b) - annualCost(a);
    });
  }, [all, filter, search, sort]);

  const reviewCount = counts.get("pending_review") ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Inventory"
        title="Subscriptions"
        description={
          <>
            Every recurring charge the detector can defend, with the evidence attached.{" "}
            {state ? `${state.stats.activeCount} are live.` : ""}
          </>
        }
        actions={
          <button type="button" className="btn" onClick={() => void scan()} disabled={scanning}>
            <RefreshCw size={13} className={scanning ? "animate-spin" : ""} />
            {scanning ? "Scanning" : "Re-detect"}
          </button>
        }
      />

      {reviewCount > 0 ? (
        <button
          type="button"
          onClick={() => setFilter("pending_review")}
          className="flex w-full items-center gap-3 border border-amber/25 bg-amber/[0.04] px-4 py-3 text-left transition-colors hover:bg-amber/[0.07]"
        >
          <TriangleAlert size={15} className="shrink-0 text-amber" />
          <span className="text-[12.5px] text-bone">
            {reviewCount} detection{reviewCount === 1 ? "" : "s"} need a second look.
          </span>
          <span className="hidden text-[11.5px] text-muted sm:inline">
            Low observation counts or ambiguous cadence — confirm or dismiss before trusting them.
          </span>
          <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.12em] text-amber">Review</span>
        </button>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
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

        <div className="relative min-w-[180px] flex-1 sm:max-w-[260px]">
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            className="input pl-8"
            placeholder="Search merchant or category"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search subscriptions"
          />
        </div>

        <label className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-faint">Sort</span>
          <select
            className="input h-9 w-[150px] cursor-pointer"
            value={sort}
            onChange={(event) => setSort(event.target.value as Sort)}
            aria-label="Sort subscriptions"
          >
            <option value="annual">Annual cost</option>
            <option value="next">Next charge</option>
            <option value="name">Name</option>
            <option value="confidence">Confidence</option>
          </select>
        </label>
      </div>

      <Panel>
        <div className="hidden grid-cols-[1fr_90px_100px_100px_110px_110px_100px_24px] items-center gap-4 border-b border-line-soft px-5 py-2.5 font-mono text-[8px] uppercase tracking-[0.14em] text-faint lg:grid">
          <span>Merchant</span>
          <span>Status</span>
          <span>Cadence</span>
          <span className="text-right">Per cycle</span>
          <span className="text-right">Per year</span>
          <span>Next charge</span>
          <span>Confidence</span>
          <span />
        </div>

        {query.loading ? (
          <div className="space-y-0">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-[62px] animate-pulse border-b border-line-soft bg-surface/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <Empty
            title={all.length === 0 ? "No subscriptions yet" : "Nothing matches that filter"}
            body={
              all.length === 0
                ? "Import a bank or card statement. Garlic will list the recurring charges it finds."
                : "Try a different status, or clear the search."
            }
            action={
              all.length === 0 ? (
                <Link to="/import" className="btn">
                  Import a statement
                </Link>
              ) : (
                <button type="button" className="btn" onClick={() => { setFilter("all"); setSearch(""); }}>
                  Clear filters
                </button>
              )
            }
          />
        ) : (
          <div>
            {rows.map((sub) => {
              const days = sub.nextChargeAt
                ? Math.round(
                    (new Date(`${sub.nextChargeAt}T00:00:00Z`).getTime() -
                      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) /
                      86_400_000,
                  )
                : null;
              return (
                <Link
                  key={sub.id}
                  to={`/subscriptions/${sub.id}`}
                  className="row-hover grid grid-cols-[1fr_auto_24px] items-center gap-4 border-b border-line-soft px-5 py-3 last:border-b-0 lg:grid-cols-[1fr_90px_100px_100px_110px_110px_100px_24px]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-raised font-mono text-[9px] text-muted">
                      {sub.displayName.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] text-bone">{sub.displayName}</span>
                        {sub.needsReview ? (
                          <span className="h-1 w-1 shrink-0 rounded-full bg-amber" title="Needs review" />
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-[0.1em] text-faint">
                        <span className="truncate">{sub.category}</span>
                        <span className="lg:hidden">· {cadenceLabel(sub.cadence)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="hidden lg:block">
                    <StatusBadge status={sub.status} />
                  </div>

                  <span className="hidden font-mono text-[10px] text-muted lg:block">{cadenceLabel(sub.cadence)}</span>
                  <span className="num hidden text-right text-[12.5px] text-bone lg:block">
                    {money(sub.amountCents, sub.currency)}
                  </span>
                  <span className="num hidden text-right text-[12.5px] text-bone lg:block">
                    {money(annualCost(sub), sub.currency)}
                  </span>

                  <div className="hidden lg:block">
                    {sub.nextChargeAt ? (
                      <>
                        <div className="num text-[11.5px] text-bone">{formatDate(sub.nextChargeAt)}</div>
                        <div
                          className={`font-mono text-[8.5px] uppercase tracking-[0.1em] ${
                            days !== null && days <= 3 ? "text-amber" : "text-faint"
                          }`}
                        >
                          {relativeDay(sub.nextChargeAt)}
                        </div>
                      </>
                    ) : (
                      <span className="font-mono text-[10px] text-faint">—</span>
                    )}
                  </div>

                  <div className="hidden lg:block">
                    <Meter value={sub.confidence} />
                  </div>

                  <div className="flex items-center gap-3 lg:hidden">
                    <span className="num text-[12.5px] text-bone">{money(annualCost(sub), sub.currency)}</span>
                  </div>

                  <ChevronRight size={14} className="text-faint" />
                </Link>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-line-soft px-5 py-2.5 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
          <span>
            {rows.length} of {all.length} shown
          </span>
          <span>
            {state ? `${money(state.stats.monthlyRecurringCents)}/mo · ${money(state.stats.annualRecurringCents)}/yr` : ""}
          </span>
        </div>
      </Panel>
    </div>
  );
}

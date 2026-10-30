import { useEffect } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import {
  BellRing,
  CircleCheck,
  Info,
  Radar,
  Receipt,
  RefreshCw,
  ScanLine,
  Settings2,
  Sparkles,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { AppProvider, useApp } from "./store.tsx";
import { Wordmark } from "./components/brand.tsx";
import { Concierge } from "./components/Concierge.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Subscriptions } from "./pages/Subscriptions.tsx";
import { SubscriptionDetail } from "./pages/SubscriptionDetail.tsx";
import { Alerts } from "./pages/Alerts.tsx";
import { ImportPage } from "./pages/Import.tsx";
import { Settings } from "./pages/Settings.tsx";

const NAV = [
  { to: "/", label: "Overview", icon: Radar, end: true },
  { to: "/subscriptions", label: "Subscriptions", icon: Receipt, end: false },
  { to: "/alerts", label: "Alerts", icon: BellRing, end: false },
  { to: "/import", label: "Import", icon: Upload, end: false },
  { to: "/settings", label: "Settings", icon: Settings2, end: false },
] as const;

function NavItems({ mobile = false }: { mobile?: boolean }) {
  const { state } = useApp();
  const counts: Record<string, number | undefined> = {
    "/subscriptions": state?.counts.subscriptions,
    "/alerts": state?.counts.openAlerts,
  };

  if (mobile) {
    return (
      <nav className="flex gap-1 overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {NAV.map((item) => {
          const Icon = item.icon;
          const count = counts[item.to];
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2 rounded-[2px] border px-3 py-2 text-[12px] transition-colors ${
                  isActive
                    ? "border-line bg-raised text-bone"
                    : "border-transparent text-muted hover:text-bone"
                }`
              }
            >
              <Icon size={14} />
              {item.label}
              {count ? <span className="num text-[10px] text-faint">{count}</span> : null}
            </NavLink>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const Icon = item.icon;
        const count = counts[item.to];
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `group relative flex items-center gap-3 rounded-[2px] px-3 py-[9px] text-[13px] transition-colors ${
                isActive ? "bg-raised text-bone" : "text-muted hover:bg-raised/60 hover:text-bone"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`absolute left-0 top-1/2 h-[14px] w-[2px] -translate-y-1/2 rounded-full transition-opacity ${
                    isActive ? "bg-blood opacity-100" : "opacity-0"
                  }`}
                />
                <Icon size={15} className={isActive ? "text-blood" : "text-faint group-hover:text-muted"} />
                <span className="flex-1">{item.label}</span>
                {count ? <span className="num text-[10px] text-faint">{count}</span> : null}
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

function StatusRail() {
  const { state, setConciergeOpen, scan, scanning } = useApp();
  const ai = state?.ai;
  const aiLabel = !ai?.enabled
    ? "AI off"
    : ai.configured
      ? `${ai.provider} · ${ai.model}`
      : "Rules engine · no key";
  const aiColor = !ai?.enabled ? "var(--color-faint)" : ai.configured ? "var(--color-acid)" : "var(--color-amber)";

  return (
    <div className="flex flex-col gap-3">
      <button type="button" className="btn btn-primary w-full justify-between" onClick={() => setConciergeOpen(true)}>
        <span className="flex items-center gap-2">
          <Sparkles size={14} />
          Ask Garlic
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] opacity-50">AI</span>
      </button>

      <button type="button" className="btn w-full justify-start" onClick={() => void scan()} disabled={scanning}>
        <RefreshCw size={13} className={scanning ? "animate-spin" : ""} />
        {scanning ? "Scanning statements…" : "Scan statements"}
      </button>

      <div className="space-y-2 border-t border-line-soft pt-3">
        <div className="flex items-center gap-2" title={ai?.reason ?? undefined}>
          <span className="h-[5px] w-[5px] shrink-0 rounded-full" style={{ background: aiColor }} />
          <span className="truncate font-mono text-[9px] uppercase tracking-[0.1em] text-faint">{aiLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-acid" />
          <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
            {state ? `${state.counts.transactions} txns on device` : "connecting…"}
          </span>
        </div>
      </div>
    </div>
  );
}

function Sidebar() {
  const { state } = useApp();
  const account = state?.accounts[0];

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[252px] flex-col border-r border-line-soft bg-ink/80 px-5 py-6 lg:flex">
      <Link to="/" className="block">
        <Wordmark />
      </Link>

      {account ? (
        <div className="mt-7 flex items-center gap-2.5 border-y border-line-soft py-3">
          <span className="grid h-7 w-7 place-items-center rounded-full border border-line bg-raised font-mono text-[9px] text-muted">
            {account.institution.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[12px] text-bone">{account.name}</div>
            <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
              ···{account.mask} · {account.currency}
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-6 flex-1">
        <div className="eyebrow mb-2.5 px-3">Ledger</div>
        <NavItems />
      </div>

      <StatusRail />

      <div className="mt-5 border-t border-line-soft pt-3 font-mono text-[8px] uppercase leading-relaxed tracking-[0.14em] text-faint/70">
        Statements stay on this machine
      </div>
    </aside>
  );
}

function MobileHeader() {
  const { setConciergeOpen, scan, scanning } = useApp();
  return (
    <header className="sticky top-0 z-30 border-b border-line-soft bg-ink/95 backdrop-blur lg:hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <Link to="/">
          <Wordmark compact />
        </Link>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost h-8 px-2"
            onClick={() => void scan()}
            disabled={scanning}
            aria-label="Scan statements"
          >
            <ScanLine size={15} className={scanning ? "animate-pulse" : ""} />
          </button>
          <button type="button" className="btn h-8 px-3 text-[12px]" onClick={() => setConciergeOpen(true)}>
            <Sparkles size={13} />
            Ask
          </button>
        </div>
      </div>
      <NavItems mobile />
    </header>
  );
}

function Toaster() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[80] flex w-[min(380px,calc(100vw-2.5rem))] flex-col gap-2">
      {toasts.map((item) => {
        const Icon = item.tone === "ok" ? CircleCheck : item.tone === "error" ? TriangleAlert : Info;
        const color = item.tone === "ok" ? "text-acid" : item.tone === "error" ? "text-blood" : "text-muted";
        return (
          <div
            key={item.id}
            className="animate-rise pointer-events-auto flex items-start gap-3 border border-line bg-raised px-3.5 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
          >
            <Icon size={14} className={`mt-0.5 shrink-0 ${color}`} />
            <p className="flex-1 text-[12px] leading-relaxed text-bone">{item.message}</p>
            <button
              type="button"
              onClick={() => dismissToast(item.id)}
              className="text-faint transition-colors hover:text-bone"
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname]);
  return null;
}

function Shell() {
  const location = useLocation();
  return (
    <div className="grain min-h-screen bg-ink">
      <Sidebar />
      <div className="lg:pl-[252px]">
        <MobileHeader />
        <main key={location.pathname} className="animate-rise mx-auto w-full max-w-[1240px] px-5 pb-16 pt-7 sm:px-8 lg:px-10 lg:pt-10">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/subscriptions" element={<Subscriptions />} />
            <Route path="/subscriptions/:id" element={<SubscriptionDetail />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
        <footer className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center justify-between gap-2 border-t border-line-soft px-5 py-5 font-mono text-[9px] uppercase tracking-[0.14em] text-faint sm:px-8 lg:px-10">
          <span>Garlic</span>
          <span>Every cancellation needs your confirmation</span>
        </footer>
      </div>
      <Concierge />
      <Toaster />
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-[50vh] flex-col items-start justify-center gap-3">
      <div className="eyebrow">404</div>
      <h1 className="text-[40px] leading-none">This page is not in the ledger.</h1>
      <Link to="/" className="btn mt-2">
        Back to overview
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <ScrollToTop />
      <Shell />
    </AppProvider>
  );
}

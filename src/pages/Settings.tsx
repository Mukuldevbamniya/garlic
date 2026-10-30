import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Trash2 } from "lucide-react";
import { useApp } from "../store.tsx";
import { api } from "../lib/api.ts";
import { CURRENCIES, type AppSettings } from "../../shared/types.ts";
import { Modal, PageHeader, Panel, PanelHeader, Spinner } from "../components/ui.tsx";

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-[12px] text-bone">{label}</div>
        <p className="mt-0.5 max-w-[46ch] text-[11px] leading-relaxed text-muted">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full border transition-colors ${
          checked ? "border-acid/40 bg-acid/25" : "border-line bg-ink"
        }`}
      >
        <span
          className={`absolute top-1/2 h-[12px] w-[12px] -translate-y-1/2 rounded-full transition-all ${
            checked ? "left-[16px] bg-acid" : "left-[2px] bg-faint"
          }`}
        />
      </button>
    </label>
  );
}

export function Settings() {
  const { state, refresh, toast } = useApp();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const current = draft ?? state?.settings ?? null;
  const [clearOpen, setClearOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [clearing, setClearing] = useState(false);

  const dirty = draft !== null && state !== null && JSON.stringify(draft) !== JSON.stringify(state.settings);
  const ai = state?.ai ?? null;
  const canClear = phrase.trim().toUpperCase() === "CLEAR LEDGER" && !clearing;

  const save = async () => {
    if (!current || !dirty) return;
    setSaving(true);
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(draft),
      });
      setDraft(null);
      await refresh();
      toast("Settings saved.", "ok");
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Could not save settings.", "error");
    } finally {
      setSaving(false);
    }
  };

  const clearLedger = async () => {
    setClearing(true);
    try {
      await api("/api/ledger/clear", {
        method: "POST",
        body: JSON.stringify({ confirmation: "CLEAR LEDGER" }),
      });
      setDraft(null);
      setClearOpen(false);
      setPhrase("");
      await refresh();
      toast("Ledger cleared.", "ok");
      navigate("/import");
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Could not clear the ledger.", "error");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Preferences"
        title="Settings"
        description="Renewal lead time, dormant-plan threshold, and whether cancellation runs can mark a subscription cancelled."
      />

      <div className="grid gap-5 lg:grid-cols-12">
        <Panel className="lg:col-span-7">
          <PanelHeader eyebrow="Detection and alerts" title="How Garlic behaves" />
          <div className="px-5 py-2">
            {!current ? (
              <div className="space-y-3 py-4">
                <div className="h-10 animate-pulse bg-surface" />
                <div className="h-10 animate-pulse bg-surface" />
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 border-b border-line-soft py-3">
                  <label className="block">
                    <span className="eyebrow mb-1.5 block">Currency</span>
                    <select
                      className="input h-9 w-full cursor-pointer"
                      value={current.currency}
                      onChange={(event) =>
                        setDraft({ ...current, currency: event.target.value as AppSettings["currency"] })
                      }
                    >
                      {CURRENCIES.map((currency) => (
                        <option key={currency} value={currency}>
                          {currency}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="eyebrow mb-1.5 block">Renewal lead</span>
                    <select
                      className="input h-9 w-full cursor-pointer"
                      value={current.alertLeadDays}
                      onChange={(event) => setDraft({ ...current, alertLeadDays: Number(event.target.value) })}
                    >
                      {[0, 1, 3, 5, 7, 10, 14].map((days) => (
                        <option key={days} value={days}>
                          {days === 0 ? "On the day" : `${days} days before`}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="border-b border-line-soft py-3">
                  <span className="eyebrow mb-1.5 block">Dormant after</span>
                  <select
                    className="input h-9 w-full cursor-pointer"
                    value={current.zombieAfterDays}
                    onChange={(event) => setDraft({ ...current, zombieAfterDays: Number(event.target.value) })}
                  >
                    {[30, 45, 60, 90, 120, 180].map((days) => (
                      <option key={days} value={days}>
                        {days} days without use
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-[11px] leading-relaxed text-muted">
                    Plans unused longer than this show up as recoverable on the overview.
                  </p>
                </div>

                <Toggle
                  checked={current.aiEnabled}
                  onChange={(next) => setDraft({ ...current, aiEnabled: next })}
                  label="AI explanations"
                  description={
                    ai?.configured
                      ? `Use ${ai.provider} / ${ai.model} for merchant notes, reviews, and Ask Garlic.`
                      : "No provider key is configured, so explanations stay on the local rules."
                  }
                />

                <Toggle
                  checked={current.dryRunOnly}
                  onChange={(next) => setDraft({ ...current, dryRunOnly: next })}
                  label="Rehearsal only"
                  description="Cancellation runs walk the steps but never mark the subscription cancelled."
                />

                <div className="flex items-center justify-between gap-3 border-t border-line-soft py-3">
                  <span className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-faint">
                    {dirty ? "unsaved changes" : "saved"}
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary h-8 px-3 text-[11px]"
                    onClick={() => void save()}
                    disabled={!dirty || saving}
                  >
                    {saving ? <Spinner /> : <Check size={12} />}
                    Save changes
                  </button>
                </div>
              </>
            )}
          </div>
        </Panel>

        <Panel className="lg:col-span-5">
          <PanelHeader eyebrow="Ledger" title="Clear stored statements" />
          <div className="space-y-4 px-5 py-4">
            <p className="text-[12px] leading-relaxed text-muted">
              Removes every imported transaction, subscription, alert, and cancellation on this machine. Settings return
              to their defaults.
            </p>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setPhrase("");
                setClearOpen(true);
              }}
            >
              <Trash2 size={13} />
              Clear ledger
            </button>
          </div>
        </Panel>
      </div>

      <Modal
        open={clearOpen}
        onClose={() => {
          if (!clearing) {
            setClearOpen(false);
            setPhrase("");
          }
        }}
        width="520px"
        label="Clear ledger"
      >
        <div className="border-b border-line-soft px-6 py-5 pr-14">
          <div className="eyebrow mb-2 text-blood">Irreversible</div>
          <h2 className="text-[26px] leading-none">Clear the ledger?</h2>
        </div>
        <div className="space-y-4 px-6 py-5">
          <p className="text-[12px] leading-relaxed text-muted">
            This deletes the statements and subscriptions stored in the local database. Import a new CSV afterward to
            start again.
          </p>
          <div>
            <div className="eyebrow mb-2">
              Type <span className="text-blood">CLEAR LEDGER</span> to confirm
            </div>
            <input
              className="input font-mono tracking-[0.06em]"
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              placeholder="CLEAR LEDGER"
              spellCheck={false}
              autoComplete="off"
              aria-label="Confirmation phrase"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-6 py-4">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setClearOpen(false);
              setPhrase("");
            }}
            disabled={clearing}
          >
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void clearLedger()} disabled={!canClear}>
            {clearing ? <Spinner /> : <Trash2 size={13} />}
            Clear ledger
          </button>
        </div>
      </Modal>
    </div>
  );
}

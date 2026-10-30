import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  CircleCheck,
  FileText,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { useApp } from "../store.tsx";
import { api } from "../lib/api.ts";
import type { AppState } from "../../shared/types.ts";
import { formatDate, money } from "../lib/format.ts";
import { PageHeader, Panel, PanelHeader, Spinner } from "../components/ui.tsx";

interface PreviewRow {
  line: number;
  postedAt: string;
  descriptor: string;
  amountCents: number;
  merchantKey: string;
  merchantName: string;
  duplicate: boolean;
}

interface Preview {
  rows: PreviewRow[];
  errors: Array<{ line: number; message: string }>;
  detectedColumns: { date: string | null; description: string | null; amount: string | null };
  signConvention: "charges_positive" | "charges_negative";
  totals: {
    parsed: number;
    duplicates: number;
    skipped: number;
    firstDate: string | null;
    lastDate: string | null;
  };
}

interface CommitResult {
  inserted: number;
  skipped: number;
  errors: Array<{ line: number; message: string }>;
  stats: AppState["stats"];
}

const COLUMN_LABEL: Record<"date" | "description" | "amount", string> = {
  date: "Date",
  description: "Description",
  amount: "Amount",
};

export function ImportPage() {
  const { state, refresh, toast } = useApp();
  const [csv, setCsv] = useState("");
  const [accountId, setAccountId] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const selectedAccount = accountId || state?.accounts[0]?.id || "";

  const lineCount = useMemo(() => csv.split(/\r?\n/).filter((line) => line.trim() !== "").length, [csv]);
  const duplicateCount = preview?.totals.duplicates ?? 0;
  const usableRows = preview ? preview.rows.length : 0;

  const readFile = async (file: File) => {
    setError(null);
    setResult(null);
    setPreview(null);
    try {
      const text = await file.text();
      if (text.length > 2_000_000) {
        setError("That file is larger than the 2 MB import limit.");
        return;
      }
      setCsv(text);
      toast(`Loaded ${file.name}.`, "ok");
    } catch {
      setError("The browser could not read that file.");
    }
  };

  const runPreview = async () => {
    if (csv.trim().length === 0) return;
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const payload = await api<Preview>("/api/import/preview", {
        method: "POST",
        body: JSON.stringify({ csv }),
      });
      setPreview(payload);
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : "Could not parse that statement.");
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy("commit");
    setError(null);
    try {
      const payload = await api<CommitResult>("/api/import/commit", {
        method: "POST",
        body: JSON.stringify({ csv, accountId: selectedAccount || undefined }),
      });
      setResult(payload);
      setPreview(null);
      await refresh();
      toast(
        `${payload.inserted} transactions imported · ${payload.stats.activeCount} subscriptions tracked`,
        "ok",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import that statement.");
    } finally {
      setBusy(null);
    }
  };

  const reset = () => {
    setCsv("");
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Statement intake"
        title="Import a CSV"
        description={
          <>
            Drop in an export from your bank or card. Garlic matches merchants, skips rows already imported, and scans
            for recurring charges.
          </>
        }
        actions={
          <button type="button" className="btn" onClick={reset} disabled={busy !== null || csv.length === 0}>
            <RefreshCw size={13} />
            Clear
          </button>
        }
      />

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-8">
          <Panel>
            <PanelHeader
              eyebrow="Step 01"
              title="Paste or drop the statement"
              action={
                <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
                  {lineCount} lines · {csv.length.toLocaleString()} chars
                </span>
              }
            />
            <div className="px-5 py-4">
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  const file = event.dataTransfer.files[0];
                  if (file) void readFile(file);
                }}
                className={`border border-dashed px-4 py-3 text-center transition-colors ${
                  dragging ? "border-acid/50 bg-acid/[0.04]" : "border-line bg-ink/40"
                }`}
              >
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void readFile(file);
                  }}
                />
                <button
                  type="button"
                  className="btn h-8 px-3 text-[11.5px]"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={12} />
                  Choose a CSV
                </button>
                <span className="ml-3 text-[11px] text-faint">or drag it onto this box</span>
              </div>

              <textarea
                className="input mt-3 min-h-[220px] w-full resize-y font-mono text-[11px] leading-relaxed"
                value={csv}
                onChange={(event) => {
                  setCsv(event.target.value);
                  setPreview(null);
                  setResult(null);
                }}
                placeholder={"Date,Description,Amount\n2026-10-01,NETFLIX.COM,15.49\n…"}
                spellCheck={false}
                aria-label="CSV contents"
              />

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void runPreview()}
                  disabled={busy !== null || csv.trim().length === 0}
                >
                  {busy === "preview" ? <Spinner /> : <FileText size={13} />}
                  {busy === "preview" ? "Parsing…" : "Preview import"}
                </button>
                {state && state.accounts.length > 0 ? (
                  <label className="ml-auto flex items-center gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-faint">Account</span>
                    <select
                      className="input h-9 w-[230px] max-w-full cursor-pointer"
                      value={selectedAccount}
                      onChange={(event) => setAccountId(event.target.value)}
                      aria-label="Target account"
                    >
                      {state.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name} ···{account.mask}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            </div>
          </Panel>

          {error ? (
            <div className="flex items-start gap-2.5 border border-blood/30 bg-blood/[0.06] px-4 py-3">
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-blood" />
              <p className="text-[12px] leading-relaxed text-bone">{error}</p>
            </div>
          ) : null}

          {result ? (
            <Panel className="border-acid/25">
              <PanelHeader eyebrow="Import complete" title="The ledger has been updated" />
              <div className="space-y-4 px-5 py-4">
                <div className="flex items-start gap-3">
                  <CircleCheck size={17} className="mt-0.5 shrink-0 text-acid" />
                  <p className="text-[12.5px] leading-relaxed text-muted">
                    <span className="text-bone">{result.inserted}</span> transactions were added and{" "}
                    <span className="text-bone">{result.skipped}</span> were skipped as duplicates. Detection ran
                    automatically; {result.stats.activeCount} subscriptions are now tracked at{" "}
                    {money(result.stats.monthlyRecurringCents)} a month.
                  </p>
                </div>
                {result.errors.length > 0 ? (
                  <div className="border border-amber/25 bg-amber/[0.04] px-3.5 py-3">
                    <div className="eyebrow mb-1 text-amber">{result.errors.length} rows skipped</div>
                    <ul className="space-y-1">
                      {result.errors.slice(0, 6).map((row) => (
                        <li key={`${row.line}-${row.message}`} className="font-mono text-[10px] text-muted">
                          line {row.line}: {row.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Link to="/subscriptions" className="btn btn-primary">
                    Review subscriptions
                    <ArrowUpRight size={12} />
                  </Link>
                  <Link to="/alerts" className="btn">
                    Open alerts
                  </Link>
                  <button type="button" className="btn btn-ghost" onClick={reset}>
                    Import another
                  </button>
                </div>
              </div>
            </Panel>
          ) : null}

          {preview ? (
            <Panel>
              <PanelHeader
                eyebrow="Step 02"
                title="Confirm what will be written"
                action={
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void commit()}
                    disabled={busy !== null || usableRows === 0}
                  >
                    {busy === "commit" ? <Spinner /> : <ShieldCheck size={13} />}
                    {busy === "commit" ? "Importing…" : `Import ${usableRows} rows`}
                  </button>
                }
              />
              <div className="grid grid-cols-2 divide-line-soft border-b border-line-soft sm:grid-cols-4 sm:divide-x">
                {[
                  { label: "Parsed", value: preview.totals.parsed.toString() },
                  { label: "New rows", value: (usableRows - duplicateCount).toString() },
                  { label: "Duplicates", value: duplicateCount.toString() },
                  { label: "Skipped", value: preview.totals.skipped.toString() },
                ].map((item) => (
                  <div key={item.label} className="border-b border-line-soft px-4 py-3 sm:border-b-0">
                    <div className="eyebrow mb-1.5">{item.label}</div>
                    <div className="num text-[20px] leading-none text-bone">{item.value}</div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line-soft px-5 py-2.5 font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
                <span>
                  Range {formatDate(preview.totals.firstDate, { withYear: true })} —{" "}
                  {formatDate(preview.totals.lastDate, { withYear: true })}
                </span>
                <span>
                  Sign convention:{" "}
                  {preview.signConvention === "charges_positive" ? "charges positive" : "charges negative"}
                </span>
                <span>Detected: {Object.values(preview.detectedColumns).filter(Boolean).length}/3 columns</span>
              </div>

              {preview.errors.length > 0 ? (
                <div className="border-b border-line-soft bg-amber/[0.03] px-5 py-3">
                  <div className="eyebrow mb-1.5 text-amber">
                    {preview.errors.length} row{preview.errors.length === 1 ? "" : "s"} cannot be parsed
                  </div>
                  <ul className="space-y-0.5">
                    {preview.errors.slice(0, 8).map((row) => (
                      <li key={`${row.line}-${row.message}`} className="font-mono text-[10px] text-muted">
                        line {row.line}: {row.message}
                      </li>
                    ))}
                  </ul>
                  {preview.errors.length > 8 ? (
                    <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
                      + {preview.errors.length - 8} more
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="grid grid-cols-[54px_92px_1fr_auto] gap-3 border-b border-line-soft px-5 py-2 font-mono text-[8px] uppercase tracking-[0.14em] text-faint">
                <span>Line</span>
                <span>Date</span>
                <span>Descriptor → merchant</span>
                <span className="text-right">Amount</span>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                {preview.rows.slice(0, 120).map((row) => (
                  <div
                    key={`${row.line}-${row.descriptor}-${row.amountCents}`}
                    className={`grid grid-cols-[54px_92px_1fr_auto] items-center gap-3 border-b border-line-soft px-5 py-2 last:border-b-0 ${
                      row.duplicate ? "opacity-45" : ""
                    }`}
                  >
                    <span className="num font-mono text-[9px] text-faint">{row.line}</span>
                    <span className="num text-[10.5px] text-muted">{formatDate(row.postedAt, { withYear: true })}</span>
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[10.5px] text-bone">{row.descriptor}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-[0.1em] text-faint">
                        <span>{row.merchantName}</span>
                        {row.duplicate ? <span className="text-amber">already imported</span> : null}
                      </div>
                    </div>
                    <span className={`num text-right text-[11.5px] ${row.amountCents < 0 ? "text-acid" : "text-bone"}`}>
                      {money(row.amountCents)}
                    </span>
                  </div>
                ))}
              </div>
              {preview.rows.length > 120 ? (
                <div className="border-t border-line-soft px-5 py-2 font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
                  Showing the first 120 of {preview.rows.length} parsed rows — all of them will be imported.
                </div>
              ) : null}
            </Panel>
          ) : null}
        </div>

        <div className="space-y-5 lg:col-span-4">
          <Panel>
            <PanelHeader eyebrow="Column detection" title={preview ? "What was found" : "Waiting for a file"} />
            <div className="divide-y divide-line-soft">
              {(["date", "description", "amount"] as const).map((key) => {
                const detected = preview?.detectedColumns[key] ?? null;
                return (
                  <div key={key} className="flex items-center justify-between gap-3 px-5 py-3">
                    <span className="text-[11.5px] text-muted">{COLUMN_LABEL[key]}</span>
                    <span
                      className={`font-mono text-[9px] uppercase tracking-[0.1em] ${
                        detected ? "text-acid" : preview ? "text-amber" : "text-faint"
                      }`}
                    >
                      {detected ?? (preview ? "not found" : "—")}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-line-soft px-5 py-3">
              <p className="text-[11px] leading-relaxed text-faint">
                Header names are matched loosely: <span className="text-muted">posted at</span>,{" "}
                <span className="text-muted">merchant</span>, <span className="text-muted">debit</span>, and similar
                variants all work. European decimal commas are understood.
              </p>
            </div>
          </Panel>

          <div className="border border-line-soft bg-surface/50 px-5 py-4">
            <div className="eyebrow mb-1.5">Ledger totals</div>
            <p className="text-[11.5px] leading-relaxed text-muted">
              {state
                ? `${state.counts.transactions} transactions and ${state.counts.subscriptions} subscriptions are already stored on this device.`
                : "Connecting to the local ledger…"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

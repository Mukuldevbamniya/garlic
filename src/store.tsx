import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AppState } from "../shared/types.ts";
import { api } from "./lib/api.ts";

type ToastTone = "ok" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface AppContextValue {
  state: AppState | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<AppState | null>;
  applyState: (next: AppState) => void;
  scan: () => Promise<void>;
  scanning: boolean;
  toast: (message: string, tone?: ToastTone) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  conciergeOpen: boolean;
  setConciergeOpen: (open: boolean) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [conciergeOpen, setConciergeOpen] = useState(false);
  const toastId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, tone: ToastTone = "info") => {
      toastId.current += 1;
      const id = toastId.current;
      setToasts((current) => [...current.slice(-3), { id, message, tone }]);
      window.setTimeout(() => {
        if (mounted.current) dismissToast(id);
      }, 5200);
    },
    [dismissToast],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await api<AppState>("/api/state");
      if (!mounted.current) return null;
      setState(next);
      setError(null);
      return next;
    } catch (cause) {
      if (!mounted.current) return null;
      setError(cause instanceof Error ? cause.message : "Could not reach the local API.");
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await api<{ summary: { created: number; updated: number; lapsed: number; alerts: number } }>(
        "/api/detect",
        { method: "POST" },
      );
      await refresh();
      const { created, updated, alerts } = result.summary;
      toast(
        `Scan complete · ${created} new, ${updated} refreshed, ${alerts} alert${alerts === 1 ? "" : "s"} open`,
        "ok",
      );
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Scan failed.", "error");
    } finally {
      if (mounted.current) setScanning(false);
    }
  }, [refresh, toast]);

  const applyState = useCallback((next: AppState) => {
    setState(next);
    setError(null);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      loading,
      error,
      refresh,
      applyState,
      scan,
      scanning,
      toast,
      toasts,
      dismissToast,
      conciergeOpen,
      setConciergeOpen,
    }),
    [state, loading, error, refresh, applyState, scan, scanning, toast, toasts, dismissToast, conciergeOpen],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider.");
  return value;
}

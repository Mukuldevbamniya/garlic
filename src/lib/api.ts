import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed with ${response.status}.`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

export interface QueryResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useQuery<T>(path: string, deps: readonly unknown[] = []): QueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const counter = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++counter.current;
    try {
      const result = await api<T>(path);
      if (ticket !== counter.current) return;
      setData(result);
      setError(null);
    } catch (cause) {
      if (ticket !== counter.current) return;
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      if (ticket === counter.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load, ...deps]);

  return { data, error, loading, refresh: load };
}

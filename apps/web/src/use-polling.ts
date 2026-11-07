import { useEffect, useState } from "react";
import { ApiError } from "./api.js";

export function usePolling<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  onExpired: () => void,
  interval = 3000,
  revision = 0,
) {
  const [state, setState] = useState<{
    key: string | null;
    data: T | null;
    error: unknown;
    checkedAt: Date | null;
  }>({ key: null, data: null, error: null, checkedAt: null });
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const data = await load(controller.signal);
        if (!controller.signal.aborted) setState({ key, data, error: null, checkedAt: new Date() });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onExpired();
          return;
        }
        setState((previous) => ({
          key,
          data: previous.key === key ? previous.data : null,
          checkedAt: previous.key === key ? previous.checkedAt : null,
          error,
        }));
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), interval);
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, load, onExpired, interval, revision]);
  return state.key === key ? state : { key, data: null, error: null, checkedAt: null };
}

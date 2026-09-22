"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Keeps a server resource fresh without ever recomputing it in the browser.
 *
 * The recommendation endpoints read D1 on every request and publish a
 * `validUntil`, so the UI's job is only to ask again often enough. This hook
 * refetches:
 *
 * 1. on first render, and whenever `url` changes (service, add-on or date);
 * 2. every `intervalMs` while the tab is visible;
 * 3. when the tab is focused or becomes visible again;
 * 4. whenever `revision` changes — bumped after every schedule mutation.
 *
 * Changing `url` or `revision` shows a loading state. Interval, focus and
 * visibility refreshes are silent: the last good value stays on screen, so the
 * barber never watches a panel blink every thirty seconds, and a failed
 * background poll leaves the previous answer in place rather than blanking it.
 */
export function useLiveResource<T>(
  url: string | null,
  { intervalMs, revision = 0 }: { intervalMs: number; revision?: number },
) {
  const key = url ? `${url}\u0000${revision}` : "";
  const [state, setState] = useState<{ key: string; data: T | null; error: string }>({
    key: "",
    data: null,
    error: "",
  });

  const load = useCallback(
    async (signal: AbortSignal, silent: boolean) => {
      if (!url) return;
      const requestKey = `${url}\u0000${revision}`;
      try {
        const response = await fetch(url, { signal, headers: { accept: "application/json" } });
        const body = (await response.json()) as T & { error?: string };
        if (!response.ok) throw new Error(body?.error ?? "Request failed.");
        if (signal.aborted) return;
        setState({ key: requestKey, data: body, error: "" });
      } catch (reason) {
        if (signal.aborted) return;
        if (reason instanceof Error && reason.name === "AbortError") return;
        const message = reason instanceof Error ? reason.message : "Request failed.";
        // A background refresh that fails keeps whatever is already on screen.
        setState((previous) => ({
          key: requestKey,
          data: silent ? previous.data : null,
          error: message,
        }));
      }
    },
    [url, revision],
  );

  // A changed request: show the loading state, then answer it.
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    // `load` awaits the request before it touches state, so this cannot cascade
    // renders; the rule cannot see through the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal, false);
    return () => controller.abort();
  }, [url, load]);

  // Interval, focus and visibility — all silent.
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load(controller.signal, true);
    };

    const timer = setInterval(refresh, intervalMs);
    const onVisibility = () => {
      // Coming back to the tab is the moment the data is most likely stale.
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, intervalMs, load]);

  const fresh = state.key === key;
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : "",
    /** True only while a *changed* request is outstanding. */
    loading: !!url && !fresh,
  };
}

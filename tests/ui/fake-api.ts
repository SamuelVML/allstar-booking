/**
 * A stand-in for the protected Backstage endpoints.
 *
 * Every response here mirrors the shape the real route returns — see
 * `app/api/admin/recommendations/route.ts`, `app/api/admin/bookings/availability`,
 * `app/api/admin/operations` and `app/api/admin/bookings/change`. Nothing is
 * invented: the ranking arrives already sorted, because the server sorts it and
 * the UI is not allowed to.
 */

export type RecordedCall = {
  method: string;
  /** Path and query only, so assertions do not depend on the harness port. */
  url: string;
  body?: unknown;
};

export type Ranked = { date: string; time: string; score: number; reason: string };

export type HarnessControls = {
  calls: RecordedCall[];
  /** Replaces what the ranking endpoint answers with next. */
  setRanking: (ranking: Ranked[]) => void;
  /** Drives the "saved, but the email did not go out" branch. */
  setNotificationsSent: (sent: boolean) => void;
  /**
   * Ranking requests, optionally for one service. The cadence assertions scope
   * by service so one panel's polling cannot be mistaken for another's.
   */
  rankingRequests: (service?: string) => number;
};

declare global {
  interface Window {
    __harness: HarnessControls;
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function installFakeApi({
  date,
  initialRanking,
  availableTimes,
  rankingAfterMutation,
}: {
  date: string;
  initialRanking: Ranked[];
  availableTimes: string[];
  /** Proves a refetch happened rather than a cached answer being reused. */
  rankingAfterMutation: Ranked[];
}) {
  const calls: RecordedCall[] = [];
  let ranking = initialRanking;
  let notificationsSent = true;

  window.__harness = {
    calls,
    setRanking: (next) => {
      ranking = next;
    },
    setNotificationsSent: (sent) => {
      notificationsSent = sent;
    },
    rankingRequests: (service) =>
      calls.filter(
        (call) =>
          call.url.startsWith("/api/admin/recommendations") &&
          (!service || call.url.includes(`service=${service}`)),
      ).length,
  };

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = raw.startsWith("http") ? new URL(raw).pathname + new URL(raw).search : raw;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    // Anything that is not a Backstage endpoint (Vite's own module requests,
    // for instance) goes to the network untouched and unrecorded.
    if (!url.startsWith("/api/")) return realFetch(input, init);
    calls.push({ method, url, body });

    if (url.startsWith("/api/admin/recommendations")) {
      const now = Date.now();
      return json({
        service: new URLSearchParams(url.split("?")[1] ?? "").get("service"),
        date,
        recommendations: ranking,
        generatedAt: new Date(now).toISOString(),
        validUntil: new Date(now + 30_000).toISOString(),
      });
    }

    if (url.startsWith("/api/admin/bookings/availability")) {
      return json({ times: availableTimes });
    }

    if (url.startsWith("/api/admin/operations")) {
      ranking = rankingAfterMutation;
      return json({ saved: true });
    }

    if (url.startsWith("/api/admin/bookings/change")) {
      ranking = rankingAfterMutation;
      return json({ changed: true, revision: 1, notificationsSent });
    }

    return json({ error: `Unhandled endpoint: ${url}` }, 404);
  };
}

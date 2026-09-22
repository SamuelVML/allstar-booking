"use client";

import { useLiveResource } from "@/hooks/use-live-resource";

/** Backstage polls its protected recommendations twice a minute. */
export const BACKSTAGE_REFRESH_MS = 30_000;

/**
 * The protected ranking endpoint, scoped to one service and day. Exported so
 * the contract the UI depends on is covered by a test rather than by reading.
 */
export function recommendationUrl({
  serviceId,
  date,
  colourAddOn = false,
}: {
  serviceId: string;
  date: string;
  colourAddOn?: boolean;
}) {
  if (!serviceId || !date) return null;
  const params = new URLSearchParams({ service: serviceId, date });
  if (colourAddOn) params.set("addOn", "colour");
  return `/api/admin/recommendations?${params.toString()}`;
}

export type RankedRecommendation = {
  date: string;
  time: string;
  score: number;
  reason: string;
};

/**
 * Samaritan's ranking for staff, from `/api/admin/recommendations`.
 *
 * Everything shown here — the order, the score and the sentence explaining the
 * pick — is produced server-side and rendered verbatim. The browser never
 * ranks or re-scores anything; it only asks again on the Backstage cadence and
 * after every schedule mutation.
 */
export default function SamaritanPanel({
  serviceId,
  date,
  colourAddOn = false,
  revision,
  selectedTime,
  onPick,
}: {
  serviceId: string;
  /** Limits the ranking to one day. */
  date: string;
  colourAddOn?: boolean;
  /** Bumped after every schedule mutation to force a refetch. */
  revision: number;
  selectedTime?: string;
  onPick: (time: string) => void;
}) {
  const url = recommendationUrl({ serviceId, date, colourAddOn });

  const { data, error, loading } = useLiveResource<{
    recommendations?: RankedRecommendation[];
  }>(url, { intervalMs: BACKSTAGE_REFRESH_MS, revision });

  const recommendations = data?.recommendations ?? [];
  const top = recommendations[0];

  return (
    <section className="samaritan-staff" aria-label="Samaritan recommends" aria-live="polite">
      <p className="kicker kicker-on-dark">Samaritan recommends</p>

      {loading && (
        <div className="samaritan-loading">
          <span className="spinner spinner-dark" aria-hidden="true" />
          Ranking the open times…
        </div>
      )}

      {!loading && error && (
        <p className="samaritan-staff-note">
          {error} Pick a time from the grid below.
        </p>
      )}

      {!loading && !error && !top && (
        <p className="samaritan-staff-note">
          Nothing fits this service on this day.
        </p>
      )}

      {!loading && !error && top && (
        <>
          <div className="samaritan-staff-times">
            {recommendations.map((recommendation, index) => (
              <button
                key={`${recommendation.date}-${recommendation.time}`}
                type="button"
                className="samaritan-staff-time"
                aria-pressed={recommendation.time === selectedTime}
                onClick={() => onPick(recommendation.time)}
              >
                <b>{recommendation.time}</b>
                {index === 0 && <span className="best">Best</span>}
              </button>
            ))}
          </div>
          <p className="samaritan-staff-reason pretty">{top.reason}</p>
        </>
      )}
    </section>
  );
}

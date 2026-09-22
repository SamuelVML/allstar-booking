"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  addMinutes,
  type BookingSettings,
  type OpeningPeriod,
} from "@/lib/booking";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function clone(settings: BookingSettings): BookingSettings {
  return JSON.parse(JSON.stringify(settings)) as BookingSettings;
}

function BreakEditor({
  breaks,
  hours,
  onChange,
}: {
  breaks: OpeningPeriod[];
  hours: OpeningPeriod;
  onChange: (breaks: OpeningPeriod[]) => void;
}) {
  function addBreak() {
    const start = breaks.at(-1)?.end ?? hours.start;
    const end = addMinutes(start, 15);
    if (end <= hours.end) onChange([...breaks, { start, end }]);
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {breaks.map((period, index) => (
        <div key={index} className="settings-break">
          <input
            className="input"
            type="time"
            step={300}
            aria-label={`Break ${index + 1} starts`}
            value={period.start}
            onChange={(event) => {
              const next = [...breaks];
              next[index] = { ...period, start: event.target.value };
              onChange(next);
            }}
          />
          <span className="muted">–</span>
          <input
            className="input"
            type="time"
            step={300}
            aria-label={`Break ${index + 1} ends`}
            value={period.end}
            onChange={(event) => {
              const next = [...breaks];
              next[index] = { ...period, end: event.target.value };
              onChange(next);
            }}
          />
          <button
            type="button"
            className="btn btn-outline btn-xs"
            aria-label={`Remove break ${index + 1}`}
            onClick={() => onChange(breaks.filter((_, item) => item !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-outline btn-xs"
        style={{ justifySelf: "start" }}
        disabled={breaks.length >= 8}
        onClick={addBreak}
      >
        + Add break
      </button>
    </div>
  );
}

export default function SettingsForm({
  initialSettings,
  initialRevision,
}: {
  initialSettings: BookingSettings;
  initialRevision: number;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(() => clone(initialSettings));
  const [saved, setSaved] = useState(() => clone(initialSettings));
  const [revision, setRevision] = useState(initialRevision);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  function updateDay(
    weekday: number,
    hours: OpeningPeriod | null,
    breaks = settings.dailyBreaks[weekday] ?? [],
  ) {
    setSettings((current) => ({
      ...current,
      openingHours: { ...current.openingHours, [weekday]: hours },
      dailyBreaks: { ...current.dailyBreaks, [weekday]: hours ? breaks : [] },
    }));
  }

  function updateRule(
    key: keyof Pick<
      BookingSettings,
      | "handlingBufferMinutes"
      | "onlineLeadMinutes"
      | "bookingWindowDays"
      | "paymentHoldMinutes"
      | "loyaltyRewardPoints"
    >,
    value: string,
  ) {
    setSettings((current) => ({ ...current, [key]: Number(value) }));
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings, revision }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        settings?: BookingSettings;
        revision?: number;
      };
      if (!response.ok || !result.settings || result.revision === undefined) {
        throw new Error(result.error ?? "Settings could not be saved.");
      }
      setSettings(clone(result.settings));
      setSaved(clone(result.settings));
      setRevision(result.revision);
      setMessage({ text: "Settings saved. New availability uses them immediately." });
      router.refresh();
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Settings could not be saved.",
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="display display-s" style={{ margin: "22px 0 4px" }}>
        Opening hours
      </h2>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 12 }}>
        Changes affect customer availability, Samaritan recommendations and Backstage. Use
        time off for one-off closures.
      </p>

      <div style={{ borderTop: "1px solid var(--hairline)" }}>
        {WEEK_ORDER.map((weekday) => {
          const hours = settings.openingHours[weekday];
          const breaks = settings.dailyBreaks[weekday] ?? [];
          return (
            <section key={weekday} className="settings-day">
              <strong style={{ paddingTop: 12 }}>{DAY_NAMES[weekday]}</strong>
              <div>
                <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 40 }}>
                  <input
                    type="checkbox"
                    checked={hours !== null}
                    onChange={(event) =>
                      updateDay(
                        weekday,
                        event.target.checked ? { start: "10:00", end: "18:00" } : null,
                      )
                    }
                  />
                  Open
                </label>
                {hours && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 6, alignItems: "center" }}>
                    <input
                      className="input"
                      type="time"
                      step={300}
                      aria-label={`${DAY_NAMES[weekday]} opens`}
                      value={hours.start}
                      onChange={(event) =>
                        updateDay(weekday, { ...hours, start: event.target.value })
                      }
                    />
                    <span className="muted">–</span>
                    <input
                      className="input"
                      type="time"
                      step={300}
                      aria-label={`${DAY_NAMES[weekday]} closes`}
                      value={hours.end}
                      onChange={(event) =>
                        updateDay(weekday, { ...hours, end: event.target.value })
                      }
                    />
                  </div>
                )}
              </div>
              <div>
                <span className="label" style={{ display: "block", marginBottom: 8 }}>
                  Recurring breaks
                </span>
                {hours ? (
                  <BreakEditor
                    breaks={breaks}
                    hours={hours}
                    onChange={(next) => updateDay(weekday, hours, next)}
                  />
                ) : (
                  <span className="muted" style={{ fontSize: 13 }}>Closed</span>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <h2 className="display display-s" style={{ margin: "28px 0 4px" }}>
        Booking rules
      </h2>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 12 }}>
        These limits apply to new customer bookings. Existing appointments keep the buffer
        reserved when they were created.
      </p>
      <div className="settings-rules">
        {([
          ["handlingBufferMinutes", "Handling buffer", "Minutes after each service", 0, 60],
          ["onlineLeadMinutes", "Online lead time", "Minimum notice in minutes", 0, 1440],
          ["bookingWindowDays", "Booking window", "Days customers can book ahead", 1, 365],
          ["paymentHoldMinutes", "Online payment hold", "Minutes reserved during checkout", 15, 1440],
          ["loyaltyRewardPoints", "Loyalty reward", "Points needed for the reward", 1, 100],
        ] as const).map(([key, label, help, min, max]) => (
          <label className="field" key={key}>
            <span className="label">{label}</span>
            <input
              className="input"
              type="number"
              min={min}
              max={max}
              step={1}
              value={settings[key]}
              onChange={(event) => updateRule(key, event.target.value)}
            />
            <span className="muted" style={{ fontSize: 11 }}>{help}</span>
          </label>
        ))}
      </div>

      {message && (
        <p
          role="status"
          className="notice"
          style={{
            margin: "18px 0 0",
            color: message.error ? "var(--danger)" : undefined,
          }}
        >
          {message.text}
        </p>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        <button className="btn btn-primary btn-s" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </button>
        <button
          className="btn btn-outline btn-s"
          type="button"
          disabled={busy}
          onClick={() => {
            setSettings(clone(saved));
            setMessage(null);
          }}
        >
          Discard changes
        </button>
      </div>
    </form>
  );
}

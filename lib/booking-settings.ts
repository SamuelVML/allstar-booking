import { z } from "zod";
import { getD1 } from "@/db";
import {
  DEFAULT_BOOKING_SETTINGS,
  type BookingSettings,
} from "@/lib/booking";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5][05]$/);
const period = z.object({ start: time, end: time });
const weekdays = z.record(z.string(), z.unknown());

export const bookingSettingsSchema = z.object({
  openingHours: weekdays,
  dailyBreaks: weekdays,
  handlingBufferMinutes: z.number().int().min(0).max(60),
  onlineLeadMinutes: z.number().int().min(0).max(1440),
  bookingWindowDays: z.number().int().min(1).max(365),
  paymentHoldMinutes: z.number().int().min(30).max(1439),
  loyaltyRewardPoints: z.number().int().min(1).max(100),
}).transform((value, context): BookingSettings => {
  const openingHours: BookingSettings["openingHours"] = {};
  const dailyBreaks: BookingSettings["dailyBreaks"] = {};

  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const key = String(weekday);
    const parsedHours = period.nullable().safeParse(value.openingHours[key]);
    const parsedBreaks = z.array(period).max(8).safeParse(value.dailyBreaks[key]);
    if (!parsedHours.success || !parsedBreaks.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid opening hours for weekday ${weekday}.`,
      });
      return z.NEVER;
    }

    const hours = parsedHours.data;
    const breaks = parsedBreaks.data.toSorted((a, b) => a.start.localeCompare(b.start));
    if (hours && hours.start >= hours.end) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Opening time must be before closing time for weekday ${weekday}.`,
      });
      return z.NEVER;
    }
    for (let index = 0; index < breaks.length; index += 1) {
      const current = breaks[index];
      const previous = breaks[index - 1];
      if (
        current.start >= current.end ||
        !hours ||
        current.start < hours.start ||
        current.end > hours.end ||
        (previous && current.start < previous.end)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Breaks must be ordered, non-overlapping and inside opening hours for weekday ${weekday}.`,
        });
        return z.NEVER;
      }
    }
    openingHours[weekday] = hours;
    dailyBreaks[weekday] = breaks;
  }

  return {
    ...value,
    openingHours,
    dailyBreaks,
  };
});

export type StoredBookingSettings = {
  settings: BookingSettings;
  revision: number;
};

export async function readBookingSettings(
  database: D1Database = getD1(),
): Promise<StoredBookingSettings> {
  const row = await database
    .prepare("SELECT config_json, revision FROM booking_settings WHERE id = 1")
    .first<{ config_json: string; revision: number }>();
  if (!row) return { settings: DEFAULT_BOOKING_SETTINGS, revision: 0 };

  try {
    const parsed = bookingSettingsSchema.safeParse(JSON.parse(row.config_json));
    if (parsed.success) return { settings: parsed.data, revision: row.revision };
  } catch {
    // A malformed row must never make booking unavailable.
  }
  console.error("Stored booking settings are invalid; using safe defaults");
  return { settings: DEFAULT_BOOKING_SETTINGS, revision: row.revision };
}

export class SettingsConflict extends Error {}

export async function saveBookingSettings(
  settings: BookingSettings,
  expectedRevision: number,
  actor: string,
  database: D1Database = getD1(),
) {
  const result = await database
    .prepare(
      `INSERT INTO booking_settings (id, config_json, revision, updated_at, updated_by)
       SELECT 1, ?, 1, CURRENT_TIMESTAMP, ? WHERE ? = 0
       ON CONFLICT(id) DO UPDATE SET
         config_json = excluded.config_json,
         revision = booking_settings.revision + 1,
         updated_at = CURRENT_TIMESTAMP,
         updated_by = excluded.updated_by
       WHERE booking_settings.revision = ?`,
    )
    .bind(JSON.stringify(settings), actor, expectedRevision, expectedRevision)
    .run();
  if (result.meta.changes !== 1) {
    throw new SettingsConflict("Settings changed in another session. Refresh and try again.");
  }
  return expectedRevision + 1;
}

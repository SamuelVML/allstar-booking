/**
 * Server-side reads for Backstage. These run inside server components and the
 * protected API routes, never in the browser — the D1 binding is not reachable
 * from client code and authorisation is checked before any of this is called.
 */

import { getD1 } from "@/db";
import type { AdminAppointment, TimeOffBlock } from "@/lib/backstage-view";

const APPOINTMENT_COLUMNS = `reference, revision, source, customer_account_id, service_name,
  price_cents, appointment_date, start_time, end_time, customer_name, customer_email,
  customer_phone, notes, status, payment_method, payment_status`;

export async function readDay(date: string) {
  const database = getD1();
  const [appointments, blocks] = await Promise.all([
    database
      .prepare(
        `SELECT ${APPOINTMENT_COLUMNS} FROM appointments
         WHERE appointment_date = ? ORDER BY start_time, reference`,
      )
      .bind(date)
      .all<AdminAppointment>(),
    database
      .prepare(
        `SELECT id, start_time, end_time, reason FROM time_off
         WHERE date = ? AND removed_at IS NULL ORDER BY start_time`,
      )
      .bind(date)
      .all<TimeOffBlock>(),
  ]);
  return { appointments: appointments.results, blocks: blocks.results };
}

export type DatedTimeOffBlock = TimeOffBlock & { date: string };

/** Inclusive on both ends. Used by the week calendar and by Revenue. */
export async function readRange(from: string, to: string) {
  const database = getD1();
  const [appointments, blocks] = await Promise.all([
    database
      .prepare(
        `SELECT ${APPOINTMENT_COLUMNS} FROM appointments
         WHERE appointment_date >= ? AND appointment_date <= ?
         ORDER BY appointment_date, start_time, reference`,
      )
      .bind(from, to)
      .all<AdminAppointment>(),
    database
      .prepare(
        `SELECT id, date, start_time, end_time, reason FROM time_off
         WHERE date >= ? AND date <= ? AND removed_at IS NULL
         ORDER BY date, start_time`,
      )
      .bind(from, to)
      .all<DatedTimeOffBlock>(),
  ]);
  return { appointments: appointments.results, blocks: blocks.results };
}

export type CustomerRow = {
  id: string;
  name: string;
  email: string;
  phone: string;
  loyalty_points: number;
  completed_visits: number;
  last_visit_at: string | null;
  reminder_opt_in: number;
  marketing_consent: number;
};

/**
 * Search by name, email or phone. Phone is matched on digits only so the
 * barber can type a number however it is written down.
 */
export async function searchCustomers(query: string) {
  const database = getD1();
  const trimmed = query.trim();
  if (!trimmed) {
    return (
      await database
        .prepare(
          `SELECT id, name, email, phone, loyalty_points, completed_visits, last_visit_at,
            reminder_opt_in, marketing_consent
           FROM customer_accounts ORDER BY last_visit_at DESC, name LIMIT 100`,
        )
        .all<CustomerRow>()
    ).results;
  }

  const pattern = `%${trimmed.replace(/[\\%_]/g, "\\$&")}%`;
  const digits = trimmed.replace(/\D/g, "");
  const phonePattern = digits ? `%${digits}%` : "\u0000";
  const results = await database
    .prepare(
      `SELECT id, name, email, phone, loyalty_points, completed_visits, last_visit_at,
        reminder_opt_in, marketing_consent
       FROM customer_accounts
       WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
         OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') LIKE ?
       ORDER BY name, id LIMIT 100`,
    )
    .bind(pattern, pattern, phonePattern)
    .all<CustomerRow>();
  return results.results;
}

export async function readCustomer(id: string) {
  const database = getD1();
  const account = await database
    .prepare(
      `SELECT id, name, email, phone, loyalty_points, completed_visits, last_visit_at,
        reminder_opt_in, marketing_consent
       FROM customer_accounts WHERE id = ?`,
    )
    .bind(id)
    .first<CustomerRow>();
  if (!account) return null;

  const visits = await database
    .prepare(
      `SELECT ${APPOINTMENT_COLUMNS} FROM appointments
       WHERE customer_account_id = ?
       ORDER BY appointment_date DESC, start_time DESC LIMIT 100`,
    )
    .bind(id)
    .all<AdminAppointment>();

  return { account, visits: visits.results };
}

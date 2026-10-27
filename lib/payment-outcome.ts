export type PaidBooking = {
  reference: string;
  serviceName: string;
  date: string;
  time: string;
  endTime: string;
  priceCents: number;
  paymentStatus: string;
  durationMinutes?: number;
};

export type SessionResult = { booking?: PaidBooking; error?: string; outcome?: string; refunded?: boolean };

/** Reads /api/stripe/session. Only a confirmed booking renders the success
 * view; a booking cancelled before its late payment completed is reported as
 * cancelled and refunded, on the first redirect and on every refresh.
 */
export function sessionOutcome(ok: boolean, result: SessionResult):
  | { kind: "confirmed"; booking: PaidBooking }
  | { kind: "cancelled"; refunded: boolean; message: string }
  | { kind: "error"; message: string } {
  if (result.outcome === "cancelled") {
    return { kind: "cancelled", refunded: result.refunded === true, message: result.error ?? "This booking was cancelled." };
  }
  if (ok && result.booking) return { kind: "confirmed", booking: result.booking };
  return { kind: "error", message: result.error ?? "Confirmation failed." };
}

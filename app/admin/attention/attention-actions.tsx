"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props =
  | { kind: "notification"; id: string; reconcile: boolean }
  | { kind: "calendar"; id: string };

/** Decision buttons for one item of the attention list. Each choice is
 * confirmed first, because it either sends an email or changes a calendar. */
export default function AttentionActions(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, body: Record<string, unknown>, question: string) {
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The action failed. Try again.");
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The action failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const notification = (decision: "delivered" | "resend" | "dismiss", question: string) =>
    send("/api/admin/attention", { action: "resolve_notification", id: props.id, decision }, question);
  const calendar = (keep: "bookly" | "local", question: string) =>
    send("/api/admin/bookly", { action: "resolve", localId: props.id, keep }, question);

  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
      {props.kind === "notification" ? (
        <>
          {props.reconcile && (
            <button type="button" className="btn btn-outline btn-xs" disabled={busy}
              onClick={() => notification("delivered", "The customer confirmed they received this email. Close it without sending?")}>
              Received
            </button>
          )}
          <button type="button" className="btn btn-outline btn-xs" disabled={busy}
            onClick={() => notification("resend", "Send this email to the customer again now? It reflects the booking as it is now.")}>
            Resend
          </button>
          <button type="button" className="btn btn-outline btn-xs" disabled={busy}
            onClick={() => notification("dismiss", "Close this without sending (for example, you told the customer by phone)?")}>
            Dismiss
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn-outline btn-xs" disabled={busy}
            onClick={() => calendar("local", "Keep the website version and write it to Bookly? Bookly still checks the time is free.")}>
            Keep website
          </button>
          <button type="button" className="btn btn-outline btn-xs" disabled={busy}
            onClick={() => calendar("bookly", "Keep the Bookly version? The website booking follows Bookly, and a booking deleted in Bookly is cancelled and refunded.")}>
            Keep Bookly
          </button>
        </>
      )}
      {error && (
        <span role="alert" className="sub" style={{ flexBasis: "100%", textAlign: "right" }}>
          {error}
        </span>
      )}
    </span>
  );
}

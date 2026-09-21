"use client";

import { useState } from "react";

export default function CompleteButton({ reference }: { reference: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  async function completeVisit() {
    setState("loading");
    const response = await fetch("/api/admin/bookings/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference }),
    });
    if (!response.ok) {
      setState("error");
      return;
    }
    setState("done");
    window.location.reload();
  }

  return (
    <button className="complete-button" type="button" onClick={completeVisit} disabled={state !== "idle"}>
      {state === "loading" ? "Saving…" : state === "done" ? "Completed" : state === "error" ? "Try again" : "Complete + award point"}
    </button>
  );
}

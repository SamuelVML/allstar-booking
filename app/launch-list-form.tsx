"use client";

import { FormEvent, useRef, useState } from "react";
import { ArrowRight } from "@/lib/icons";

export default function LaunchListForm({ language }: { language: "en" | "nl" }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const pending = useRef(false);
  const nl = language === "nl";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    if (name.length < 2) {
      setError(true);
      setMessage(nl ? "Vul een naam van minstens twee tekens in." : "Enter a name of at least two characters.");
      form.querySelector<HTMLInputElement>('[name="name"]')?.focus();
      return;
    }
    pending.current = true;
    setBusy(true);
    setMessage("");
    setError(false);
    try {
      const response = await fetch("/api/launch-list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email: data.get("email"), consent: data.get("consent") === "on" }),
      });
      const body = await response.json() as { status?: string };
      if (!response.ok || !["subscribed", "already_subscribed"].includes(body.status ?? "")) {
        throw new Error("Subscription failed");
      }
      setMessage(body.status === "already_subscribed"
        ? (nl ? "Dit e-mailadres staat al op de lanceerlijst." : "This email is already on the launch list.")
        : (nl ? "Je staat op de lanceerlijst. We houden je op de hoogte." : "You're on the launch list. We'll keep you updated."));
    } catch {
      setError(true);
      setMessage(nl ? "Inschrijven is momenteel niet mogelijk. Probeer het opnieuw." : "Subscription is temporarily unavailable. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  if (!open) return <button className="btn btn-outline" type="button" onClick={() => setOpen(true)}>{nl ? "Zet me op de lanceerlijst" : "Join the launch list"} <ArrowRight /></button>;
  return <form className="launch-list-form" onSubmit={submit} aria-busy={busy} aria-label={nl ? "Mobile Barber lanceerlijst" : "Mobile Barber launch list"}>
    <label className="field"><span className="label">{nl ? "Naam" : "Name"}</span><input className="input" name="name" autoComplete="name" required minLength={2} maxLength={120} autoFocus /></label>
    <label className="field"><span className="label">Email</span><input className="input" name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} /></label>
    <label className="launch-consent"><input name="consent" type="checkbox" required /><span>{nl ? "Ik wil e-mails ontvangen over de lancering van All Star Mobile Barber." : "I want to receive emails about the All Star Mobile Barber launch."}</span></label>
    <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? (nl ? "Inschrijven…" : "Subscribing…") : (nl ? "Inschrijven" : "Subscribe")} <ArrowRight /></button>
    <p className={error ? "field-error" : "launch-success"} role="status" aria-live="polite">{message}</p>
  </form>;
}

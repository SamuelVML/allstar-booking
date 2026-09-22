"use client";
import { FormEvent, useState } from "react";
import { ArrowRight } from "@/lib/icons";

export default function LaunchListForm({ language }: { language: "en" | "nl" }) {
  const [open,setOpen]=useState(false); const [busy,setBusy]=useState(false); const [message,setMessage]=useState(""); const [error,setError]=useState(false);
  async function submit(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMessage(""); setError(false);
    const data=new FormData(e.currentTarget);
    try {
      const res=await fetch("/api/launch-list",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:data.get("name"),email:data.get("email"),consent:data.get("consent")==="on"})});
      const body=await res.json() as {status?:string;error?:string};
      if(!res.ok) throw new Error(body.error||"Subscription failed.");
      setMessage(body.status==="already_subscribed"?(language==="nl"?"Dit e-mailadres staat al op de lanceerlijst.":"This email is already on the launch list."):(language==="nl"?"Je staat op de lanceerlijst. We houden je op de hoogte.":"You're on the launch list. We'll keep you updated."));
    } catch(err) { setError(true); setMessage(err instanceof Error?err.message:"Subscription failed."); }
    finally { setBusy(false); }
  }
  if(!open) return <button className="btn btn-outline" type="button" onClick={()=>setOpen(true)}>{language==="nl"?"Zet me op de lanceerlijst":"Join the launch list"} <ArrowRight /></button>;
  return <form className="launch-list-form" onSubmit={submit}>
    <label className="field"><span className="label">{language==="nl"?"Naam":"Name"}</span><input className="input" name="name" autoComplete="name" required minLength={2}/></label>
    <label className="field"><span className="label">Email</span><input className="input" name="email" type="email" autoComplete="email" inputMode="email" required/></label>
    <label className="launch-consent"><input name="consent" type="checkbox" required/><span>{language==="nl"?"Ik wil updates ontvangen over de lancering van All Star Mobile Barber. Ik kan me altijd uitschrijven.":"I want to receive updates about the All Star Mobile Barber launch. I can unsubscribe at any time."}</span></label>
    <button className="btn btn-primary" disabled={busy}>{busy?(language==="nl"?"Inschrijven…":"Subscribing…"):(language==="nl"?"Inschrijven":"Subscribe")} <ArrowRight /></button>
    {message&&<p className={error?"field-error":"launch-success"} role="status">{message}</p>}
  </form>;
}

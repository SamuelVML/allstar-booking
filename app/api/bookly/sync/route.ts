import { env } from "cloudflare:workers";
import { getD1 } from "@/db";
import { booklyEnabled, synchronizeBookly } from "@/lib/bookly";
/** Private HMAC callback used by WordPress's scheduler. No customer data returned. */
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  const secret = (env as unknown as { BOOKLY_BRIDGE_SECRET?: string }).BOOKLY_BRIDGE_SECRET;
  const timestamp = request.headers.get("x-allstar-timestamp") ?? "";
  const nonce = request.headers.get("x-allstar-nonce") ?? "";
  const signature = request.headers.get("x-allstar-signature") ?? "";
  if (!booklyEnabled() || !secret || secret.length < 32 || !/^\d+$/.test(timestamp) || Math.abs(Date.now()/1000 - Number(timestamp)) > 120 || !/^[a-f0-9-]{36}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) {
    return Response.json({ error: "Not authorised." }, { status: 403, headers });
  }
  const body = await request.text();
  if (body.length > 100) return Response.json({ error: "Invalid request." }, { status: 400, headers });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = new Uint8Array(signature.match(/../g)!.map(pair => parseInt(pair,16)));
  if (!await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(`${timestamp}\n${nonce}\n/api/bookly/sync\n${body}`))) {
    return Response.json({ error: "Not authorised." }, { status: 403, headers });
  }
  const database = getD1();
  await database.prepare("DELETE FROM bookly_callback_nonces WHERE expires < ?").bind(Date.now()).run();
  try { await database.prepare("INSERT INTO bookly_callback_nonces(nonce,expires) VALUES (?,?)").bind(nonce,Date.now()+240_000).run(); }
  catch { return Response.json({ error: "Request already used." }, { status: 403, headers }); }
  try {
    await synchronizeBookly(database);
    return Response.json({ synced: true }, { headers });
  } catch { return Response.json({ error: "Sync pending. Retry on the next scheduled run." }, { status: 503, headers }); }
}

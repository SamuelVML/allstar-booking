// Keep the old route protected and use the same revision-checked operation.
import { POST as change } from "../change/route";

export async function POST(request: Request) {
  let payload;
  try { payload = await request.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return Response.json({ error: "Invalid request." }, { status: 400 });
  return change(new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({ ...payload, action: "complete" }),
  }));
}

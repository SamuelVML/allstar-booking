import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { launchListSubscribers } from "@/db/schema";

const requestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  consent: z.literal(true),
});

export async function POST(request: Request) {
  let input: z.infer<typeof requestSchema>;
  try { input = requestSchema.parse(await request.json()); }
  catch { return NextResponse.json({ error: "Please enter your name, a valid email address and confirm your subscription." }, { status: 400 }); }

  const db = getDb();
  const email = input.email.toLowerCase();
  const existing = await db.select({ id: launchListSubscribers.id }).from(launchListSubscribers).where(eq(launchListSubscribers.email, email)).limit(1);
  if (existing.length) return NextResponse.json({ status: "already_subscribed" });

  await db.insert(launchListSubscribers).values({
    id: crypto.randomUUID(),
    name: input.name,
    email,
    consent: true,
    source: "mobile_barber_launch_list",
  });
  return NextResponse.json({ status: "subscribed" }, { status: 201 });
}

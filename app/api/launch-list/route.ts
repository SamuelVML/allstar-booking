import { NextResponse } from "next/server";
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
  try {
    input = requestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Please enter your name, a valid email address and confirm your subscription." }, { status: 400 });
  }

  try {
    // Let the unique index arbitrate concurrent requests, without overwriting
    // the original subscriber's name, consent or signup timestamp.
    const inserted = await getDb().insert(launchListSubscribers).values({
      id: crypto.randomUUID(),
      name: input.name,
      email: input.email.toLowerCase(),
      consent: true,
      source: "mobile_barber_launch_list",
    }).onConflictDoNothing({ target: launchListSubscribers.email })
      .returning({ id: launchListSubscribers.id });

    return NextResponse.json(
      { status: inserted.length ? "subscribed" : "already_subscribed" },
      { status: inserted.length ? 201 : 200 },
    );
  } catch {
    return NextResponse.json(
      { error: "Subscription is temporarily unavailable. Please try again." },
      { status: 503 },
    );
  }
}

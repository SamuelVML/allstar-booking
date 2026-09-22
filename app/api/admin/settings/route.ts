import { z } from "zod";
import { authoriseStaffMutation } from "@/lib/staff-auth";
import {
  bookingSettingsSchema,
  saveBookingSettings,
  SettingsConflict,
} from "@/lib/booking-settings";

const payloadSchema = z.object({
  revision: z.number().int().min(0),
  settings: bookingSettingsSchema,
});

export async function PUT(request: Request) {
  const user = await authoriseStaffMutation(request);
  if (!user) return Response.json({ error: "Not authorised." }, { status: 403 });

  const payload = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return Response.json(
      { error: payload.error.issues[0]?.message ?? "Check the settings and try again." },
      { status: 400 },
    );
  }

  try {
    const revision = await saveBookingSettings(
      payload.data.settings,
      payload.data.revision,
      user.id,
    );
    return Response.json(
      { settings: payload.data.settings, revision },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof SettingsConflict) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("Booking settings update failed", error);
    return Response.json(
      { error: "Settings could not be saved. Try again." },
      { status: 503 },
    );
  }
}

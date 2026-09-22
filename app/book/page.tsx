import type { Metadata } from "next";
import { getTodayInEindhoven, SERVICES } from "@/lib/booking";
import { stripeIsConfigured } from "@/lib/stripe";
import { isLanguage, type Language } from "@/lib/i18n";
import BookingForm from "./booking-form";
import { readBookingSettings } from "@/lib/booking-settings";

export const metadata: Metadata = {
  title: "Book an appointment | All Star Barbershop",
  description: "Choose your All Star service, date and appointment time.",
};

export const dynamic = "force-dynamic";

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string; addOn?: string; lang?: string }>;
}) {
  const params = await searchParams;
  const initialService =
    params.service &&
    SERVICES.some((service) => service.id === params.service && !service.isAddOn)
      ? params.service
      : SERVICES[0].id;
  const language: Language = isLanguage(params.lang) ? params.lang : "en";
  const { settings } = await readBookingSettings();

  return (
    <main>
      <BookingForm
        initialService={initialService}
        initialColourAddOn={params.addOn === "colour"}
        initialLanguage={language}
        stripeEnabled={stripeIsConfigured()}
        today={getTodayInEindhoven()}
        bookingSettings={settings}
      />
    </main>
  );
}

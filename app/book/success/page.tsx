import type { Metadata } from "next";
import { isLanguage, type Language } from "@/lib/i18n";
import PaymentSuccess from "./payment-success";
import { readBookingSettings } from "@/lib/booking-settings";

export const metadata: Metadata = {
  title: "Booking confirmed | All Star Barbershop",
};

export const dynamic = "force-dynamic";

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const params = await searchParams;
  const language: Language = isLanguage(params.lang) ? params.lang : "en";
  const { settings } = await readBookingSettings();
  return (
    <main>
      <PaymentSuccess language={language} loyaltyRewardPoints={settings.loyaltyRewardPoints} />
    </main>
  );
}

import type { Metadata } from "next";
import { getTodayInEindhoven } from "@/lib/booking";
import { isLanguage, type Language } from "@/lib/i18n";
import SiteHome from "./site-home";

export const metadata: Metadata = {
  title: "All Star Barbershop | Eindhoven",
  description:
    "Precision cuts, beard grooming and colour at All Star Barbershop, Bakkerstraat 48 Eindhoven. Book your chair in under a minute — pay online or at the shop.",
};

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const params = await searchParams;
  const language: Language = isLanguage(params.lang) ? params.lang : "en";

  // Resolved server-side so "today" in the opening hours matches the shop's
  // clock rather than the visitor's device.
  const todayWeekday = new Date(
    `${getTodayInEindhoven()}T12:00:00Z`,
  ).getUTCDay();

  return <SiteHome initialLanguage={language} todayWeekday={todayWeekday} />;
}

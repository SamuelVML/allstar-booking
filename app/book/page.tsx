import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SERVICES } from "@/lib/booking";
import { stripeIsConfigured } from "@/lib/stripe";
import BookingForm from "./booking-form";

export const metadata: Metadata = {
  title: "Book an appointment | All Star Barbershop",
  description: "Choose your All Star service, date and appointment time.",
};

export const dynamic = "force-dynamic";

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string; addOn?: string }>;
}) {
  const params = await searchParams;
  const initialService = params.service && SERVICES.some(
    (service) => service.id === params.service && !service.isAddOn,
  )
    ? params.service
    : SERVICES[0].id;

  return (
    <main className="booking-page">
      <header className="booking-header">
        <Link className="brand" href="/" aria-label="All Star Barbershop home">
          <span>ALL STAR</span>
          <small>BARBERSHOP</small>
        </Link>
        <Link className="booking-back" href="/">
          <ArrowLeft aria-hidden="true" /> Back to website
        </Link>
      </header>
      <section className="booking-intro">
        <div>
          <span className="booking-kicker">Eindhoven · Amaury Reyes</span>
          <h1>Book your chair.</h1>
        </div>
        <p>Choose a service, available time and how you want to pay.</p>
      </section>
      <BookingForm
        initialService={initialService}
        initialColourAddOn={params.addOn === "colour"}
        stripeEnabled={stripeIsConfigured()}
      />
    </main>
  );
}

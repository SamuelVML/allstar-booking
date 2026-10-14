import { BOOKLY_SERVICE_MAP, SERVICES } from "@/lib/booking";

/** A Bookly catalogue row as the bridge returns it (`wp_bookly_services`). */
type BooklyServiceRow = { id: number | string; title: string; duration: number | string; price: number | string };

export type CatalogueCheck = {
  /** The bridge's service map equals the website catalogue's, one to one. */
  serviceMapMatches: boolean;
  /** Every catalogue service exists in Bookly with the same price and duration. */
  pricesAndDurationsMatch: boolean;
  differences: string[];
};

/**
 * Compares the Bookly catalogue read through the bridge with the website
 * catalogue. Owner decision D06 makes Bookly authoritative, so any difference
 * means the website must be updated to match Bookly, never the reverse.
 */
export function checkBooklyCatalogue(response: unknown): CatalogueCheck {
  const value = (response ?? {}) as { serviceMap?: unknown; services?: unknown };
  const differences: string[] = [];
  const remoteMap = value.serviceMap && typeof value.serviceMap === "object" ? value.serviceMap as Record<string, unknown> : {};
  const keys = new Set([...Object.keys(remoteMap), ...Object.keys(BOOKLY_SERVICE_MAP)]);
  for (const key of [...keys].sort()) {
    if (Number(remoteMap[key]) !== BOOKLY_SERVICE_MAP[key]) differences.push(`map ${key}: bridge ${String(remoteMap[key] ?? "missing")}, website ${BOOKLY_SERVICE_MAP[key] ?? "missing"}`);
  }
  const serviceMapMatches = differences.length === 0;
  const rows = Array.isArray(value.services) ? value.services as BooklyServiceRow[] : [];
  for (const service of SERVICES) {
    const row = rows.find(candidate => Number(candidate.id) === service.booklyServiceId);
    if (!row) { differences.push(`service ${service.booklyServiceId} (${service.id}) missing in Bookly`); continue; }
    const priceCents = Math.round(Number(row.price) * 100);
    const minutes = Number(row.duration) / 60;
    if (priceCents !== service.priceCents) differences.push(`price ${service.booklyServiceId} (${service.id}): Bookly ${priceCents}, website ${service.priceCents}`);
    if (minutes !== service.durationMinutes) differences.push(`duration ${service.booklyServiceId} (${service.id}): Bookly ${minutes}, website ${service.durationMinutes}`);
  }
  return { serviceMapMatches, pricesAndDurationsMatch: differences.length === 0 && serviceMapMatches, differences };
}

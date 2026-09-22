import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getStaffUser } from "@/lib/staff-auth";
import BackstageNav from "./nav";

export const dynamic = "force-dynamic";

/**
 * Every Backstage screen is behind Cloudflare Access and the staff allowlist.
 * The check is repeated in each page so no screen relies on this layout — or
 * on hidden UI — for its authorisation.
 */
export default async function BackstageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await getStaffUser(await headers()))) notFound();

  return (
    <div className="bs">
      <BackstageNav />
      <main className="bs-main">{children}</main>
    </div>
  );
}

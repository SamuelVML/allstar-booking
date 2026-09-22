import { redirect } from "next/navigation";

export default function BackstageIndexPage() {
  redirect("/admin/bookings");
}

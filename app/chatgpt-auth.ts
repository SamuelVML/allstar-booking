// Compatibility exports for the original template. All identity now comes from
// verified Access JWTs; raw Sites/Cloudflare identity headers are never trusted.
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getStaffUser } from "@/lib/staff-auth";

export async function getChatGPTUser() {
  const user = await getStaffUser(await headers());
  return user ? { userId: user.id, displayName: user.email, email: user.email, fullName: null } : null;
}

export async function requireChatGPTUser() {
  const user = await getChatGPTUser();
  if (!user) notFound();
  return user;
}

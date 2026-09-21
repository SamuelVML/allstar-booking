import { env } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";

let keySet: ReturnType<typeof createRemoteJWKSet> | undefined;
let keySetIssuer = "";

export async function getStaffUser(requestHeaders: Headers) {
  const issuer = env.CF_ACCESS_TEAM_DOMAIN?.trim().replace(/\/$/, "");
  const audience = env.CF_ACCESS_AUD?.trim();
  const allowed = (env.ADMIN_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  const token = requestHeaders.get("cf-access-jwt-assertion");
  if (!issuer || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !audience || !allowed.length || !token) return null;
  try {
    if (!keySet || keySetIssuer !== issuer) {
      keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
      keySetIssuer = issuer;
    }
    const { payload } = await jwtVerify(token, keySet, {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "email"],
    });
    if (typeof payload.email !== "string" || typeof payload.sub !== "string" || !payload.sub || typeof payload.iat !== "number" || payload.iat > Date.now() / 1000 + 30) return null;
    const email = payload.email.trim().toLowerCase();
    if (!allowed.includes(email)) return null;
    return { id: payload.sub, email };
  } catch {
    // Fail closed without exposing tokens or identity details in logs.
    return null;
  }
}

export async function authoriseStaffMutation(request: Request) {
  const user = await getStaffUser(request.headers);
  if (!user) return null;
  // Require a same-origin JSON request to protect cookie-authenticated staff actions.
  if (request.headers.get("origin") !== new URL(request.url).origin) return null;
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return null;
  return user;
}

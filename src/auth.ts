import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./types";

export interface AccessIdentity {
  email: string;
  sub: string;
}

// JWKS sets cached at module scope so the keys are fetched once per isolate
// instead of on every request. `createRemoteJWKSet` also handles its own
// internal caching + cooldown when keys rotate.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

// Access injects the JWT in the Cf-Access-Jwt-Assertion header. For browser
// navigations it also sets the CF_Authorization cookie — used as fallback.
function extractToken(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;

  const cookie = request.headers.get("Cookie");
  if (cookie) {
    const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    if (match) return decodeURIComponent(match[1]!);
  }
  return null;
}

/**
 * Validates a Cloudflare Access JWT. Returns the user identity or null if the
 * token is missing, malformed, or fails signature / issuer / audience checks.
 */
export async function validateAccessJWT(
  request: Request,
  env: Env,
): Promise<AccessIdentity | null> {
  const token = extractToken(request);
  if (!token) return null;
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return null;

  try {
    const jwks = getJWKS(env.TEAM_DOMAIN);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD,
    });

    const email = typeof payload["email"] === "string" ? payload["email"] : null;
    if (!email) return null;

    return { email, sub: payload.sub ?? "" };
  } catch {
    return null;
  }
}

import type { Env } from "./types";

// The Worker is the OAuth authorization server from Claude's point of view and
// an OIDC client toward Cloudflare Access. It brokers two independent PKCE
// legs:
//
//   Claude  <--PKCE A-->  Worker  <--PKCE B-->  Cloudflare Access
//
// Claude never sees CF_CLIENT_SECRET, and the Access app id never has to be
// hardcoded — the Access endpoints are discovered at runtime.

const WORKER_URL = "https://vault-api.ninomtz-victor.workers.dev";
const CALLBACK_URI = `${WORKER_URL}/oauth/callback`;

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

// Cached per isolate. The openid-configuration of Access rarely changes.
let discoveryCache: Discovery | null = null;

async function getDiscovery(env: Env): Promise<Discovery> {
  if (discoveryCache) return discoveryCache;
  const res = await fetch(`${env.TEAM_DOMAIN}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  discoveryCache = (await res.json()) as Discovery;
  return discoveryCache;
}

// ─── PKCE / random helpers ─────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function challengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ─── Metadata ──────────────────────────────────────────────────────────────────

// RFC 8414 — advertised at /.well-known/oauth-authorization-server. The Worker
// is both the authorization and token endpoint so it can broker PKCE; the JWKS
// still points at Access since the tokens are signed by Access.
export function oauthAuthorizationServerMetadata(env: Env) {
  return {
    issuer: WORKER_URL,
    authorization_endpoint: `${WORKER_URL}/oauth/authorize`,
    token_endpoint: `${WORKER_URL}/oauth/token`,
    registration_endpoint: `${WORKER_URL}/oauth/register`,
    jwks_uri: `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["openid", "email", "profile"],
  };
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

// Step 1: Claude redirects the user here. We stash Claude's PKCE challenge and
// redirect URI, mint our own PKCE pair for the Access leg, and bounce to Access.
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const clientRedirectUri = p.get("redirect_uri");
  const clientState = p.get("state");
  const clientChallenge = p.get("code_challenge");
  const clientChallengeMethod = p.get("code_challenge_method") ?? "S256";

  if (!clientRedirectUri || !clientChallenge) {
    return new Response("Missing required params (redirect_uri, code_challenge)", { status: 400 });
  }

  const disco = await getDiscovery(env);

  // Our own PKCE pair for the Worker <-> Access leg.
  const workerVerifier = randomToken();
  const workerChallenge = await challengeS256(workerVerifier);

  // Opaque value handed to Access; doubles as the KV key for this transaction.
  const accessState = randomToken();
  await env.CACHE.put(
    `oauth_state:${accessState}`,
    JSON.stringify({
      clientRedirectUri,
      clientState,
      clientChallenge,
      clientChallengeMethod,
      workerVerifier,
    }),
    { expirationTtl: 600 },
  );

  const authUrl = new URL(disco.authorization_endpoint);
  authUrl.searchParams.set("client_id", env.CF_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", CALLBACK_URI);
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", accessState);
  authUrl.searchParams.set("code_challenge", workerChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return Response.redirect(authUrl.toString(), 302);
}

// Step 2: Access redirects back here after login. We exchange the code with
// Access (using OUR verifier), then mint our own code for Claude bound to
// Claude's PKCE challenge, and redirect back to Claude.
export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const accessState = url.searchParams.get("state");

  if (!code || !accessState) return new Response("Missing code or state", { status: 400 });

  const state = (await env.CACHE.get(`oauth_state:${accessState}`, "json")) as
    | {
        clientRedirectUri: string;
        clientState: string | null;
        clientChallenge: string;
        clientChallengeMethod: string;
        workerVerifier: string;
      }
    | null;
  if (!state) return new Response("Invalid or expired state", { status: 400 });

  const disco = await getDiscovery(env);
  const tokenRes = await fetch(disco.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.CF_CLIENT_ID,
      client_secret: env.CF_CLIENT_SECRET,
      code,
      redirect_uri: CALLBACK_URI,
      code_verifier: state.workerVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    return new Response(`Token exchange with Access failed: ${detail}`, { status: 502 });
  }

  const tokens = (await tokenRes.json()) as { id_token?: string; access_token?: string };
  // The id_token is a JWT (aud = CF_CLIENT_ID) we can later verify with jose.
  const bearer = tokens.id_token ?? tokens.access_token;
  if (!bearer) return new Response("No token in Access response", { status: 502 });

  await env.CACHE.delete(`oauth_state:${accessState}`);

  // Mint our own authorization code for Claude, bound to Claude's PKCE.
  const clientCode = randomToken();
  await env.CACHE.put(
    `oauth_code:${clientCode}`,
    JSON.stringify({
      bearer,
      clientChallenge: state.clientChallenge,
      clientChallengeMethod: state.clientChallengeMethod,
    }),
    { expirationTtl: 300 },
  );

  const redirect = new URL(state.clientRedirectUri);
  redirect.searchParams.set("code", clientCode);
  if (state.clientState) redirect.searchParams.set("state", state.clientState);

  return Response.redirect(redirect.toString(), 302);
}

// Step 3: Claude exchanges its code here. We verify Claude's PKCE and hand back
// the Access id_token as the bearer token for /api/mcp.
export async function handleToken(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const grantType = form.get("grant_type");
  const code = form.get("code");
  const verifier = form.get("code_verifier");

  if (grantType !== "authorization_code" || typeof code !== "string") {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  const stored = (await env.CACHE.get(`oauth_code:${code}`, "json")) as
    | { bearer: string; clientChallenge: string; clientChallengeMethod: string }
    | null;
  if (!stored) return Response.json({ error: "invalid_grant" }, { status: 400 });

  // Verify Claude's PKCE.
  if (stored.clientChallengeMethod === "S256") {
    if (typeof verifier !== "string") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const computed = await challengeS256(verifier);
    if (computed !== stored.clientChallenge) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
  }

  await env.CACHE.delete(`oauth_code:${code}`);

  return Response.json({
    access_token: stored.bearer,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid email profile",
  });
}

// RFC 7591 Dynamic Client Registration. Claude's MCP connector registers before
// starting the flow. We are a public client (PKCE, no secret), so we accept any
// registration and echo back a generated client_id.
export async function handleRegister(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    redirect_uris?: string[];
    client_name?: string;
  };

  return Response.json(
    {
      client_id: `mcp_${crypto.randomUUID()}`,
      client_name: body.client_name ?? "mcp-client",
      redirect_uris: body.redirect_uris ?? [],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201 },
  );
}

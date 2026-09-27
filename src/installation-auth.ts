export interface InstallationAuthEnv { INSTALLATION_CREDENTIALS_JSON?: string; }
export interface InstallationAuthorization { installationId: string; }

function authError(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin",
  } });
}

interface InstallationCredential {
  id: string;
  token: string;
  origins: string[];
  originPolicy?: "require-origin" | "trusted-proxy";
}

function installationCredentials(env: InstallationAuthEnv): InstallationCredential[] {
  const parsed: unknown = JSON.parse(env.INSTALLATION_CREDENTIALS_JSON || "[]");
  if (!Array.isArray(parsed)) throw new Error("Invalid installation configuration");
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const value of parsed) {
    if (!value || typeof value !== "object" ||
        typeof value.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.id) ||
        typeof value.token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(value.token) ||
        !Array.isArray(value.origins) || !value.origins.length ||
        (value.originPolicy !== undefined && !["require-origin", "trusted-proxy"].includes(value.originPolicy)) ||
        ids.has(value.id) || tokens.has(value.token)) {
      throw new Error("Invalid installation configuration");
    }
    ids.add(value.id);
    tokens.add(value.token);
    for (const origin of value.origins) {
      if (typeof origin !== "string") throw new Error("Invalid installation configuration");
      const url = new URL(origin);
      if (!["https:", "http:"].includes(url.protocol) || url.origin !== origin) {
        throw new Error("Invalid installation configuration");
      }
    }
  }
  return parsed as InstallationCredential[];
}

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) {
    // Still walk both buffers so length leaks are less useful.
    let dig = 0;
    const n = Math.max(ba.length, bb.length);
    for (let i = 0; i < n; i++) {
      dig |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
    }
    return dig === 0 && ba.length === bb.length;
  }
  let diff = 0;
  for (let i = 0; i < ba.length; i++) {
    diff |= ba[i]! ^ bb[i]!;
  }
  return diff === 0;
}

export function requireInstallation(request: Request, env: InstallationAuthEnv): InstallationAuthorization | Response {
  const authorization = request.headers.get("Authorization");
  if (authorization === null) return authError({ error: "installation unauthorized" }, 401);
  let credentials: InstallationCredential[];
  try {
    credentials = installationCredentials(env);
  } catch {
    return authError({ error: "installation authentication unavailable" }, 503);
  }
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const installation = credentials.find((entry) => timingSafeEqual(entry.token, token));
  if (!installation) return authError({ error: "installation unauthorized" }, 401);
  // Origin is defense in depth, never the credential. The backend must override
  // Authorization and reject cross-site requests before adding its secret.
  const originHeader = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  let origin = originHeader;
  if (originHeader === null) {
    try { origin = referer ? new URL(referer).origin : null; } catch { origin = null; }
  }
  // Some managed relays enforce same-origin themselves and strip provenance.
  // Only an explicitly enrolled backend credential may use that transport.
  const trustedMissingOrigin = installation.originPolicy === "trusted-proxy" &&
    originHeader === null && referer === null;
  if ((!trustedMissingOrigin && (!origin || !installation.origins.includes(origin))) ||
      request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return authError({ error: "installation origin denied" }, 403);
  }
  return { installationId: installation.id };
}

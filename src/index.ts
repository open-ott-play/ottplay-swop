import { validSwopClientId, wire } from "./wire-contracts";
export { SwopSession } from "./session";

export interface Env {
  SWOP: KVNamespace; // allowlist only
  SESSIONS: DurableObjectNamespace;
  REQUEST_RATE_LIMIT: RateLimit;
  PUBLIC_BASE_URL: string;
  SESSION_TTL_SECONDS?: string;
  ADMIN_TOKEN?: string; // secret via wrangler secret put
  INSTALLATION_CREDENTIALS_JSON?: string; // secret [{id, token, origins}]
}

interface InstallationCredential {
  id: string;
  token: string;
  origins: string[];
  originPolicy?: "require-origin" | "trusted-proxy";
}

interface ClientAuthorization {
  clientId: string;
  installationId?: string;
}

interface AllowRecord {
  allowedAt: number;
  note?: string;
}


const CORS_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Swop-Client-Id, X-Ottplay-Client-Id, X-Swop-Session-Token",
  "Access-Control-Max-Age": "86400",
};

function json(
  data: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...CORS_HEADERS,
    },
  });
}

function ttlSeconds(env: Env): number {
  const n = Number(env.SESSION_TTL_SECONDS ?? wire.swopDefaultTtl);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : wire.swopDefaultTtl;
}

function allowKey(clientId: string): string {
  return `allow:${clientId}`;
}

function randomCode(): string {
  const bytes = new Uint8Array(wire.swopCodeLength);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < wire.swopCodeLength; i++) {
    out += wire.swopCodeAlphabet[bytes[i]! % wire.swopCodeAlphabet.length];
  }
  return out;
}

async function sessionCall(env: Env, code: string, operation: string, input: object): Promise<Response> {
  if (!env.SESSIONS) return json({ error: "session storage not configured" }, 503);
  const object = env.SESSIONS.get(env.SESSIONS.idFromName(code.toUpperCase()));
  return object.fetch(new Request("https://session.internal/" + operation, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }));
}

async function enforceRateLimit(request: Request, env: Env, installationId?: string): Promise<Response | null> {
  if (!env.REQUEST_RATE_LIMIT) return json({ error: "rate limit not configured" }, 503);
  // Cloudflare supplies this header at the edge. Local tests share a local key.
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  // Browser-chosen client IDs cannot bypass the installation/IP quota.
  const key = installationId ? `installation:${installationId}:ip:${ip}` : `ip:${ip}`;
  const { success } = await env.REQUEST_RATE_LIMIT.limit({ key });
  return success ? null : json({ error: "too many requests" }, 429, { "Retry-After": "60" });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseClientId(request: Request, body?: Record<string, unknown>): string | null {
  const raw =
    request.headers.get(wire.swopClientHeader) ??
    request.headers.get(wire.swopFallbackClientHeader) ??
    (typeof body?.clientId === "string" ? body.clientId : "");
  const id = raw.trim();
  if (!validSwopClientId(id)) {
    return null;
  }
  return id;
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== "POST") return {};
  try {
    const body: unknown = await request.clone().json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch { return {}; }
}

async function boundedRequest(request: Request, path: string): Promise<Request | Response> {
  if (request.method !== "POST" || !request.body) return request;
  // Submit preserves the existing 8,000-character limit even for UTF-8 text.
  const limit = path === wire.swopSubmitPath ? 32768 : 16384;
  const length = request.headers.get("Content-Length");
  if (length !== null && Number(length) > limit) return json({ error: "payload too large" }, 413);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return json({ error: "payload too large" }, 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request, { body });
}

function clientResponse(response: Response, request: Request, auth: ClientAuthorization): Response {
  if (!auth.installationId) return response;
  const headers = new Headers(response.headers);
  const origin = request.headers.get("Origin");
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  else headers.delete("Access-Control-Allow-Origin");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

function withoutCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("Access-Control-Allow-Origin");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

async function requireAllowlistedClient(
  request: Request,
  env: Env,
): Promise<{ clientId: string } | Response> {
  const clientId = parseClientId(request);
  if (!clientId) {
    return json({ error: "missing client id" }, 401);
  }
  const raw = await env.SWOP.get(allowKey(clientId));
  if (!raw) {
    return json({ error: "client not allowed" }, 403);
  }
  return { clientId };
}

function installationCredentials(env: Env): InstallationCredential[] {
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

async function requireClient(
  request: Request,
  env: Env,
): Promise<ClientAuthorization | Response> {
  // A supplied but invalid credential must never fall back to the weaker legacy path.
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    let credentials: InstallationCredential[];
    try {
      credentials = installationCredentials(env);
    } catch {
      return json({ error: "installation authentication unavailable" }, 503);
    }
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const installation = credentials.find((entry) => timingSafeEqual(entry.token, token));
    if (!installation) return json({ error: "installation unauthorized" }, 401);
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
      return json({ error: "installation origin denied" }, 403);
    }
    const body = await objectBody(request);
    let clientId = parseClientId(request, body);
    if (!clientId) {
      const supplied = request.headers.get(wire.swopClientHeader) ??
        request.headers.get(wire.swopFallbackClientHeader) ?? body.clientId;
      const creating = request.method === "POST" &&
        new URL(request.url).pathname.replace(/\/+$/, "") === wire.swopSessionPath;
      if ((supplied === undefined || supplied === "") && creating) {
        // Legacy TV runtimes may lack secure RNG. This ID belongs to one session.
        clientId = `swop_${randomToken()}`;
      } else return json({ error: "missing client id" }, 401);
    }
    return { clientId, installationId: installation.id };
  }
  return requireAllowlistedClient(request, env);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
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

function requireAdmin(request: Request, env: Env): Response | null {
  const token = (env.ADMIN_TOKEN ?? "").trim();
  if (!token) {
    return json({ error: "admin not configured" }, 503);
  }
  const auth = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix)) {
    return json({ error: "unauthorized" }, 401);
  }
  const presented = auth.slice(prefix.length).trim();
  if (!timingSafeEqual(presented, token)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function normalizeEntryCode(value: string): string | null {
  if (value.length > 64 || !/^[A-Za-z2-9 \t\r\n-]+$/.test(value)) return null;
  const normalized = value.toUpperCase().replace(/[ \t\r\n-]/g, "");
  return new RegExp(`^[${wire.swopCodeAlphabet}]{${wire.swopCodeLength * 2}}$`).test(normalized) ? normalized : null;
}

function entryPage(error = false): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Remote text entry</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
  body { margin: 0 auto; max-width: 28rem; padding: 1.5rem; }
  h1 { font-size: 1.4rem; } p { line-height: 1.5; }
  label { display: block; margin: 1.25rem 0 .5rem; }
  input, button { width: 100%; box-sizing: border-box; padding: .9rem; border-radius: .5rem; font: inherit; }
  input { border: 1px solid #8888; font-size: 1.4rem; letter-spacing: .12em; text-transform: uppercase; }
  button { margin-top: 1rem; border: 0; background: #2563eb; color: #fff; cursor: pointer; }
  .error { color: #dc2626; }
</style></head><body>
<h1>Enter text for your TV</h1>
<p>Enter the 12-character code shown on your TV. You can include or omit the space or hyphen.</p>
${error ? '<p class="error" role="alert">Code unavailable. Check the full code or request a new one on your TV.</p>' : ""}
<form action="/" method="get">
  <label for="entry">TV code</label>
  <input id="entry" name="entry" type="text" placeholder="ABCDEF-GHJKLM" maxlength="32" autocomplete="off" autocapitalize="characters" spellcheck="false" required autofocus />
  <button type="submit">Continue</button>
</form></body></html>`;
}

function formPage(code: string, caption: string, draft: string, token = "", entryCode = ""): string {
  const safeCaption = escapeHtml(caption || "Enter value");
  const safeDraft = escapeHtml(draft);
  const safeCode = escapeHtml(code);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeCaption}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
    body { margin: 0; padding: 1.25rem; max-width: 28rem; margin-inline: auto; }
    h1 { font-size: 1.15rem; margin: 0 0 1rem; }
    label { display: block; font-size: 0.85rem; margin-bottom: 0.35rem; opacity: 0.85; }
    input[type=text], textarea {
      width: 100%; box-sizing: border-box; padding: 0.75rem; font-size: 1rem;
      border-radius: 0.5rem; border: 1px solid #8884; margin-bottom: 1rem;
    }
    button {
      width: 100%; padding: 0.85rem; font-size: 1rem; border: 0; border-radius: 0.5rem;
      background: #2563eb; color: #fff; font-weight: 600; cursor: pointer;
    }
    button:disabled { opacity: 0.6; cursor: default; }
    .msg { margin-top: 1rem; font-size: 0.95rem; }
    .err { color: #dc2626; }
    .ok { color: #16a34a; }
    .code { font-variant-numeric: tabular-nums; letter-spacing: 0.08em; opacity: 0.7; font-size: 0.8rem; }
  </style>
</head>
<body>
  <p class="code">Session ${safeCode}</p>
  <h1>${safeCaption}</h1>
  <form id="f">
    <label for="value">Value</label>
    <textarea id="value" name="value" rows="4" required autocomplete="off">${safeDraft}</textarea>
    <button type="submit" id="btn">Submit</button>
  </form>
  <p class="msg" id="msg" hidden></p>
  <script>
    const form = document.getElementById("f");
    const btn = document.getElementById("btn");
    const msg = document.getElementById("msg");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      msg.hidden = true;
      try {
        const value = document.getElementById("value").value;
        const res = await fetch(${JSON.stringify(wire.swopSubmitPath)}, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: ${JSON.stringify(code)}, token: ${JSON.stringify(token)}, ${entryCode ? `entryCode: ${JSON.stringify(entryCode)}, ` : ""}value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        msg.className = "msg ok";
        msg.textContent = "Submitted. You can close this page.";
        msg.hidden = false;
      } catch (err) {
        msg.className = "msg err";
        msg.textContent = err && err.message ? err.message : "Submit failed";
        msg.hidden = false;
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

async function handleSession(
  request: Request,
  env: Env,
  auth: ClientAuthorization,
): Promise<Response> {
  let body: { caption?: string; draft?: string } = {};
  try {
    body = (await request.json()) as { caption?: string; draft?: string };
  } catch {
    // empty body ok
  }
  const caption = typeof body.caption === "string" ? body.caption.slice(0, wire.swopCaptionLimit) : "";
  const draft = typeof body.draft === "string" ? body.draft.slice(0, wire.swopDraftLimit) : "";
  const ttl = ttlSeconds(env);
  const sessionToken = auth.installationId ? randomToken() : undefined;
  const submitToken = auth.installationId ? randomToken() : undefined;
  const capabilities = auth.installationId ? {
    installationId: auth.installationId,
    sessionTokenHash: await tokenHash(sessionToken!),
    submitTokenHash: await tokenHash(submitToken!),
  } : {};
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = randomCode();
    const entryCode = auth.installationId ? `${code}-${randomCode()}` : undefined;
    const response = await sessionCall(env, code, "create", {
      clientId: auth.clientId, caption, draft, ttl, ...capabilities,
      ...(entryCode ? { entryCodeHash: await tokenHash(normalizeEntryCode(entryCode)!) } : {}),
    });
    if (response.status === 409) continue;
    if (!response.ok) return json(await response.json(), response.status);
    const base = (env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    return json({ code, url: `${base}/?c=${encodeURIComponent(code)}${submitToken ? `&t=${submitToken}` : ""}`, expiresIn: ttl,
      ...(sessionToken ? { sessionToken, clientId: auth.clientId, entryUrl: `${base}/`, entryCode } : {}) });
  }
  return json({ error: "could not allocate session" }, 503);
}

async function handleForm(url: URL, env: Env): Promise<Response> {
  if (url.searchParams.has("entry")) {
    const entryCode = normalizeEntryCode(url.searchParams.get("entry") || "");
    if (!entryCode) return html(entryPage(true), 400);
    const code = entryCode.slice(0, wire.swopCodeLength);
    const response = await sessionCall(env, code, "form", { entryCodeHash: await tokenHash(entryCode) });
    if (!response.ok) return html(entryPage(true), 400);
    const data = await response.json() as { caption?: string; draft?: string };
    return html(formPage(code, data.caption || "", data.draft || "", "", entryCode));
  }
  const code = (url.searchParams.get("c") || "").trim().toUpperCase();
  if (!code) return html(entryPage());
  const supplied = url.searchParams.get("t") || "";
  const token = /^[a-f0-9]{64}$/.test(supplied) ? supplied : "";
  const response = await sessionCall(env, code, "form", { submitTokenHash: await tokenHash(token) });
  if (response.status === 410) return html("<!DOCTYPE html><title>Gone</title><p>Session expired or not found.</p>", 410);
  if (response.status === 409) return html("<!DOCTYPE html><title>Already submitted</title><p>This session already has a value.</p>", 409);
  const data = await response.json() as { caption?: string; draft?: string };
  if (!response.ok) return json(data, response.status);
  return html(formPage(code, data.caption || "", data.draft || "", token));
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  let body: { code?: string; value?: string; token?: string; entryCode?: string };
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const value = typeof body.value === "string" ? body.value : "";
  if (!code || !value) return json({ error: "code and value are required" }, 400);
  if (value.length > wire.swopValueLimit) return json({ error: "value too long" }, 400);
  const manual = body.entryCode !== undefined;
  const entryCode = manual && typeof body.entryCode === "string" ? normalizeEntryCode(body.entryCode) : null;
  if (manual && (!entryCode || entryCode.slice(0, wire.swopCodeLength) !== code)) {
    return json({ error: "entry code unavailable" }, 403);
  }
  const response = await sessionCall(env, code, "submit", {
    value, ttl: ttlSeconds(env), submitTokenHash: await tokenHash(typeof body.token === "string" ? body.token : ""),
    ...(entryCode ? { entryCodeHash: await tokenHash(entryCode) } : {}),
  });
  if (manual && !response.ok) return json({ error: "entry code unavailable" }, 403);
  return json(await response.json(), response.status);
}

async function handleVal(request: Request, url: URL, env: Env, auth: ClientAuthorization): Promise<Response> {
  const body = await objectBody(request);
  const code = (url.searchParams.get("c") || (typeof body.code === "string" ? body.code : "")).trim().toUpperCase();
  if (!code) return json({ error: "missing c" }, 400);
  const response = await sessionCall(env, code, "consume", {
    clientId: auth.clientId, installationId: auth.installationId,
    sessionTokenHash: await tokenHash(request.headers.get("X-Swop-Session-Token") || (typeof body.sessionToken === "string" ? body.sessionToken : "")),
  });
  return json(await response.json(), response.status);
}

async function handleAdminCreateClient(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: { clientId?: string; note?: string };
  try {
    body = (await request.json()) as { clientId?: string; note?: string };
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const clientId =
    typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!validSwopClientId(clientId)) {
    return json({ error: "invalid clientId" }, 400);
  }
  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, wire.swopNoteLimit) : undefined;
  const record: AllowRecord = {
    allowedAt: Date.now(),
    ...(note ? { note } : {}),
  };
  await env.SWOP.put(allowKey(clientId), JSON.stringify(record));
  return json({ ok: true, clientId, ...record }, 201);
}

async function handleAdminDeleteClient(
  url: URL,
  env: Env,
): Promise<Response> {
  const id = (url.searchParams.get("id") || "").trim();
  if (!validSwopClientId(id)) {
    return json({ error: "invalid id" }, 400);
  }
  const key = allowKey(id);
  const existing = await env.SWOP.get(key);
  if (existing === null) {
    return json({ error: "not found" }, 404);
  }
  await env.SWOP.delete(key);
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function handleAdminListClients(env: Env): Promise<Response> {
  const listed = await env.SWOP.list({ prefix: "allow:" });
  const clients: Array<{ clientId: string; allowedAt?: number; note?: string }> =
    [];
  const readConcurrency = 4;
  for (let offset = 0; offset < listed.keys.length; offset += readConcurrency) {
    const keys = listed.keys.slice(offset, offset + readConcurrency);
    const records = await Promise.allSettled(keys.map(async (key) => env.SWOP.get(key.name)));
    // Consume settled reads in list order, including which error is reported.
    for (let index = 0; index < keys.length; index++) {
      const result = records[index]!;
      if (result.status === "rejected") throw result.reason;
      const clientId = keys[index]!.name.slice("allow:".length);
      const raw = result.value;
      if (!raw) {
        clients.push({ clientId });
        continue;
      }
      try {
        const rec = JSON.parse(raw) as AllowRecord;
        clients.push({
          clientId,
          allowedAt: rec.allowedAt,
          ...(rec.note ? { note: rec.note } : {}),
        });
      } catch {
        clients.push({ clientId });
      }
    }
  }
  return json({ clients });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      const bounded = await boundedRequest(request, path);
      if (bounded instanceof Response) {
        return request.headers.has("Authorization") ? withoutCors(bounded) : bounded;
      }
      request = bounded;
      if (request.method === "GET" && path === "/health") {
        return json({ ok: true });
      }

      const protectedRoute = (path === wire.swopSessionPath && request.method === "POST") ||
        (path === wire.swopValuePath && ["GET", "POST"].includes(request.method));
      const installationAuth = protectedRoute && request.headers.has("Authorization") ?
        await requireClient(request, env) : undefined;
      const limited = await enforceRateLimit(request, env,
        installationAuth && !(installationAuth instanceof Response) ? installationAuth.installationId : undefined);
      if (limited) {
        if (installationAuth instanceof Response) return withoutCors(limited);
        return installationAuth ? clientResponse(limited, request, installationAuth) : limited;
      }
      if (installationAuth instanceof Response) return withoutCors(installationAuth);

      if (path === "/admin/clients") {
        const denied = requireAdmin(request, env);
        if (denied) {
          return denied;
        }
        if (request.method === "POST") {
          return await handleAdminCreateClient(request, env);
        }
        if (request.method === "DELETE") {
          return await handleAdminDeleteClient(url, env);
        }
        if (request.method === "GET") {
          return await handleAdminListClients(env);
        }
        return json({ error: "method not allowed" }, 405);
      }

      if (request.method === "POST" && path === wire.swopSessionPath) {
        const auth = installationAuth || await requireClient(request, env);
        if (auth instanceof Response) {
          return auth;
        }
        return clientResponse(await handleSession(request, env, auth), request, auth);
      }
      if (request.method === "POST" && path === wire.swopSubmitPath) {
        return await handleSubmit(request, env);
      }
      if ((request.method === "GET" || request.method === "POST") && path === wire.swopValuePath) {
        const auth = installationAuth || await requireClient(request, env);
        if (auth instanceof Response) {
          return auth;
        }
        return clientResponse(await handleVal(request, url, env, auth), request, auth);
      }
      if (request.method === "GET" && path === "/") {
        return await handleForm(url, env);
      }
      return json({ error: "not found" }, 404);
    } catch {
      // Storage/configuration errors can contain operational details or secrets.
      const response = json({ error: "internal error" }, 500);
      return request.headers.has("Authorization") &&
        [wire.swopSessionPath, wire.swopValuePath].includes(path) ? withoutCors(response) : response;
    }
  },
};

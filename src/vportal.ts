import { requireInstallation, type InstallationAuthEnv } from "./installation-auth";

export interface VPortalEnv extends InstallationAuthEnv {
  VPORTAL_ENDPOINTS_JSON?: string;
  REQUEST_RATE_LIMIT?: RateLimit;
}

export const VPORTAL_LIMITS = {
  request: 128 * 1024,
  params: 64 * 1024,
  response: 8 * 1024 * 1024,
  timeout: 25000,
  concurrent: 2,
};
let activeRelays = 0;

const RESPONSE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Pragma": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Vary": "Origin",
};

function error(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { ...RESPONSE_HEADERS, ...extra },
  });
}

type RelayFailureCode = "upstream_http" | "transport" | "response_limit" | "invalid_json" | "timeout";

function relayFailure(code: RelayFailureCode, upstreamStatus?: number): Response {
  return new Response(JSON.stringify({
    error: code === "timeout" ? "VPortal request timed out" : "VPortal request failed",
    code,
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
  }), { status: code === "timeout" ? 504 : 502, headers: RESPONSE_HEADERS });
}

function canonicalEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || /[^\x21-\x7e]|[%\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    const labels = url.hostname.split(".");
    const validHostname = url.hostname.length <= 253 && labels.length >= 2 && labels.every(label =>
      label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
    return ["https:", "http:"].includes(url.protocol) && url.href === value &&
      !url.username && !url.password && !url.hash && !url.search && !url.port &&
      validHostname &&
      !/^\d+(?:\.\d+){3}$/.test(url.hostname) &&
      !/\.(?:localhost|local|internal)$/.test(url.hostname);
  } catch { return false; }
}

function endpoints(env: VPortalEnv): string[] | null {
  try {
    const value: unknown = JSON.parse(env.VPORTAL_ENDPOINTS_JSON || "[]");
    return Array.isArray(value) && value.length > 0 && value.every(canonicalEndpoint) ? value : null;
  } catch { return null; }
}

class ByteLimitError extends Error {}

async function boundedBody(message: Request | Response, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const length = message.headers.get("Content-Length");
  if (length !== null && Number(length) > limit) {
    void message.body?.cancel().catch(() => {});
    throw new ByteLimitError();
  }
  if (signal?.aborted) {
    void message.body?.cancel().catch(() => {});
    throw new Error();
  }
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { cancel(); throw new ByteLimitError(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function relay(url: string, params: string): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error()); }, VPORTAL_LIMITS.timeout);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const upstream = await fetch(url, {
        // workerd supports "manual", not the browser's "error" mode. Reject
        // every returned 3xx below, before any second request can expose a key.
        method: "POST", body: params, redirect: "manual", signal: controller.signal,
        headers: {
          "Content-Type": "application/json", "Accept": "application/json",
          "Cache-Control": "no-store", "User-Agent": "OTT-play-FOSS/1.0",
        },
      });
      // Never forward redirects or upstream error bodies that might echo a key.
      if (!upstream.ok || upstream.status === 204) {
        void upstream.body?.cancel().catch(() => {});
        return relayFailure("upstream_http", upstream.status);
      }
      const bytes = await boundedBody(upstream, VPORTAL_LIMITS.response, controller.signal);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
        JSON.parse(text); // Legacy PHP endpoints may label valid JSON as text/html.
      } catch { return relayFailure("invalid_json"); }
      return new Response(text, { status: upstream.status, headers: RESPONSE_HEADERS });
    })()]);
  } catch (reason) {
    return relayFailure(timedOut ? "timeout" : reason instanceof ByteLimitError ? "response_limit" : "transport");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

/** Installation-only, exact-destination relay. No cookies or caller headers are forwarded. */
export async function handleVPortal(request: Request, env: VPortalEnv): Promise<Response> {
  try {
    if (request.method !== "POST") return error(405, "Method not allowed", { Allow: "POST" });
    const auth = requireInstallation(request, env);
    if (!env.REQUEST_RATE_LIMIT) return error(503, "VPortal unavailable");
    const installation = auth instanceof Response ? "unauthorized" : auth.installationId;
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const limited = await env.REQUEST_RATE_LIMIT.limit({ key: `vportal:installation:${installation}:ip:${ip}` });
    if (!limited.success) return error(429, "Too many requests", { "Retry-After": "60" });
    if (auth instanceof Response) return auth;
    const allowed = endpoints(env);
    if (!allowed) return error(503, "VPortal unavailable");
    if ((request.headers.get("Content-Type") || "").split(";")[0]!.trim().toLowerCase() !== "application/json") {
      return error(415, "JSON request required");
    }
    let body: unknown;
    try {
      const bytes = await boundedBody(request, VPORTAL_LIMITS.request);
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch (reason) {
      return reason instanceof ByteLimitError ? error(413, "VPortal request too large") : error(400, "Invalid VPortal request");
    }
    if (!object(body) || Object.keys(body).some(key => key !== "url" && key !== "params") ||
        !canonicalEndpoint(body.url) || !object(body.params) || body.params.app !== "ott-play" ||
        typeof body.params.key !== "string" || !body.params.key.trim()) {
      return error(400, "Invalid VPortal request");
    }
    if (!allowed.includes(body.url)) return error(403, "VPortal destination not allowed");
    const params = JSON.stringify(body.params);
    if (new TextEncoder().encode(params).byteLength > VPORTAL_LIMITS.params) return error(413, "VPortal request too large");
    // Bound concurrent response buffers within this isolate, in addition to the
    // installation/IP rate limit. This is not a distributed concurrency quota.
    if (activeRelays >= VPORTAL_LIMITS.concurrent) return error(503, "VPortal busy", { "Retry-After": "5" });
    activeRelays++;
    try { return await relay(body.url, params); }
    finally { activeRelays--; }
  } catch {
    return error(502, "VPortal request failed");
  }
}

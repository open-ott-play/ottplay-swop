import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { VPORTAL_LIMITS, type VPortalEnv } from "../vportal";

const ENDPOINT = "http://portal.example/api/v1/";
const TOKEN = "installation-secret-" + "a".repeat(40);
const KEY = "private-portal-key";
const ORIGIN = "https://player.example";

function environment(): VPortalEnv {
  return {
    INSTALLATION_CREDENTIALS_JSON: JSON.stringify([
      { id: "player", token: TOKEN, origins: [ORIGIN], originPolicy: "trusted-proxy" },
      { id: "local", token: "b".repeat(48), origins: [ORIGIN] },
    ]),
    VPORTAL_ENDPOINTS_JSON: JSON.stringify([ENDPOINT]),
    REQUEST_RATE_LIMIT: { limit: vi.fn().mockResolvedValue({ success: true }) },
  };
}

function request(body: unknown = { url: ENDPOINT, params: { app: "ott-play", key: KEY } }, headers: Record<string, string> = {}): Request {
  return new Request("https://swop.example/vportal/api", {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function run(req = request(), env = environment()): Promise<Response> {
  return worker.fetch(req, env as never);
}

async function safeError(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  const text = await response.text();
  expect(JSON.parse(text)).toHaveProperty("error");
  for (const secret of [TOKEN, KEY, ENDPOINT, "private failure detail"]) expect(text).not.toContain(secret);
}

describe("installation-only VPortal relay", () => {
  let upstream: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    upstream = vi.fn().mockResolvedValue(new Response('{"items":[]}'));
    vi.stubGlobal("fetch", upstream);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("accepts the browser envelope, forwards only params and fixed headers, and serves JSON without CORS or caching", async () => {
    upstream.mockResolvedValue(new Response('{"items":[{"title":"TV"}]}', {
      headers: { "Content-Type": "text/html", "Set-Cookie": "leak=yes", "Access-Control-Allow-Origin": "*" },
    }));
    const params = { app: "ott-play", key: KEY, action: "get_channels", page: 2 };
    const response = await run(request({ url: ENDPOINT, params }, {
      Cookie: "session=private", "X-Swop-Client-Id": "client", "X-Private": "private", Origin: ORIGIN,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ title: "TV" }] });
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", body: JSON.stringify(params) });
    expect(init.headers).toEqual({
      "Content-Type": "application/json", Accept: "application/json", "Cache-Control": "no-store",
      "User-Agent": "OTT-play-FOSS/1.0",
    });
  });

  it.each(["GET", "OPTIONS", "PUT"])("rejects %s without wildcard preflight", async method => {
    await safeError(await run(new Request("https://swop.example/vportal/api", { method })), 405);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects anonymous, wrong-secret, and legacy allowlisted clients", async () => {
    for (const authorization of [null, "Bearer wrong-secret"]) {
      const req = request();
      if (authorization) req.headers.set("Authorization", authorization); else req.headers.delete("Authorization");
      req.headers.set("X-Swop-Client-Id", "allowlisted-client");
      const env = { ...environment(), SWOP: { get: vi.fn().mockResolvedValue('{"allowedAt":1}') } };
      await safeError(await run(req, env), 401);
      expect(env.SWOP.get).not.toHaveBeenCalled();
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("requires exact origin for strict credentials and denies hostile provenance even with a trusted proxy secret", async () => {
    const strict = { Authorization: `Bearer ${"b".repeat(48)}` };
    await safeError(await run(request(undefined, strict)), 403);
    expect((await run(request(undefined, { ...strict, Origin: ORIGIN }))).status).toBe(200);
    for (const headers of [
      { Origin: "https://copy.example" }, { Origin: "null" }, { Referer: "https://copy.example/" },
      { "Sec-Fetch-Site": "cross-site" },
    ]) await safeError(await run(request(undefined, headers)), 403);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("uses a separate installation/IP rate key and fails closed without the binding", async () => {
    const env = environment();
    await run(request(undefined, { "CF-Connecting-IP": "203.0.113.9" }), env);
    expect(env.REQUEST_RATE_LIMIT!.limit).toHaveBeenCalledExactlyOnceWith({ key: "vportal:installation:player:ip:203.0.113.9" });
    vi.mocked(env.REQUEST_RATE_LIMIT!.limit).mockResolvedValue({ success: false });
    const limited = await run(request(), env);
    expect(limited.headers.get("Retry-After")).toBe("60");
    await safeError(limited, 429);
    delete env.REQUEST_RATE_LIMIT;
    await safeError(await run(request(), env), 503);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each([undefined, "[]", "{}", "not JSON", '["https://portal.example:8443/api/"]'])("fails closed on unconfigured or invalid destination allowlist %s", async allowed => {
    await safeError(await run(request(), { ...environment(), VPORTAL_ENDPOINTS_JSON: allowed }), 503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    "https://other.example/api/v1/", "http://portal.example/api/v2/", "https://portal.example/api/v1/",
  ])("requires an exact allowed destination: %s", async url => {
    await safeError(await run(request({ url, params: { app: "ott-play", key: KEY } })), 403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    "ftp://portal.example/api/", "http://user:pass@portal.example/api/", "http://portal.example/api/#fragment",
    "http://portal.example/api/?key=private", "http://portal.example:8443/api/", "http://portal.example:80/api/",
    "http://127.0.0.1/api/", "http://2130706433/api/", "http://[::1]/api/", "http://portal.local/api/",
    "http://portal.example/api/../api/v1/", "http://portal.example/%61pi/v1/", "http://PORTAL.example/api/v1/",
    "http://portal.example\\@evil.example/api/", "http://portal.example/api/v1/ ", "//portal.example/api/v1/",
  ])("rejects unsafe or ambiguous destinations: %s", async url => {
    await safeError(await run(request({ url, params: { app: "ott-play", key: KEY } })), 400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { url: ENDPOINT, params: [] }, { url: ENDPOINT, params: null },
    { url: ENDPOINT, params: { app: "other", key: KEY } }, { url: ENDPOINT, params: { app: "ott-play", key: "  " } },
    { url: ENDPOINT, params: { app: "ott-play", key: 1 } },
    { url: ENDPOINT, params: { app: "ott-play", key: KEY }, headers: { Authorization: "no" } },
  ])("rejects malformed envelopes and portal credentials", async body => {
    await safeError(await run(request(body)), 400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("bounds DNS labels and rejects pathological hostnames before any upstream request", async () => {
    for (const hostname of [
      "a".repeat(4000) + ".example", "a".repeat(63) + "-".repeat(3000) + ".example",
      "a".repeat(64) + ".example", Array(4).fill("a".repeat(63)).join("."),
    ]) {
      await safeError(await run(request({ url: `http://${hostname}/`, params: { app: "ott-play", key: KEY } })), 400);
    }
    expect(upstream).not.toHaveBeenCalled();
    const maximumHostname = [63, 63, 63, 61].map(length => "a".repeat(length)).join(".");
    const url = `http://${maximumHostname}/`;
    expect((await run(request({ url, params: { app: "ott-play", key: KEY } }), {
      ...environment(), VPORTAL_ENDPOINTS_JSON: JSON.stringify([url]),
    })).status).toBe(200);
  }, 1000);

  it("rejects non-JSON, malformed JSON, and invalid UTF-8 requests", async () => {
    await safeError(await run(request(undefined, { "Content-Type": "text/plain" })), 415);
    for (const body of ["{", new Uint8Array([0xff])]) {
      await safeError(await run(new Request("https://swop.example/vportal/api", {
        method: "POST", headers: request().headers, body,
      })), 400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("enforces announced and actual request sizes before upstream access", async () => {
    await safeError(await run(request(undefined, { "Content-Length": String(VPORTAL_LIMITS.request + 1) })), 413);
    const large = request({ url: ENDPOINT, params: { app: "ott-play", key: KEY }, padding: "x".repeat(VPORTAL_LIMITS.request) });
    await safeError(await run(large), 413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("bounds encoded params bytes, including multibyte strings, below the envelope limit", async () => {
    await safeError(await run(request({ url: ENDPOINT, params: { app: "ott-play", key: KEY, query: "я".repeat(33000) } })), 413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 400, 401, 500])("does not forward HTTP %s error bodies or redirect credentials", async status => {
    upstream.mockResolvedValue(new Response(`${KEY} ${TOKEN} private failure detail`, {
      status, headers: { Location: "https://evil.example/", "Set-Cookie": KEY },
    }));
    const response = await run();
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.clone().json()).toEqual({ error: "VPortal request failed", code: "upstream_http", upstreamStatus: status });
    await safeError(response, 502);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0][1].redirect).toBe("manual");
  });

  it("sanitizes thrown transport errors and non-JSON successful responses", async () => {
    upstream.mockRejectedValueOnce(new Error(`${KEY} ${TOKEN} ${ENDPOINT} private failure detail`));
    const failed = await run();
    expect(await failed.clone().json()).toEqual({ error: "VPortal request failed", code: "transport" });
    await safeError(failed, 502);
    for (const body of ["<html>private failure detail</html>", "{", new Uint8Array([0xff])]) {
      upstream.mockResolvedValueOnce(new Response(body));
      const invalid = await run();
      expect(await invalid.clone().json()).toEqual({ error: "VPortal request failed", code: "invalid_json" });
      await safeError(invalid, 502);
    }
  });

  it("rejects announced oversized responses and caps chunked responses", async () => {
    upstream.mockResolvedValueOnce(new Response("{}", { headers: { "Content-Length": String(VPORTAL_LIMITS.response + 1) } }));
    const announced = await run();
    expect(await announced.clone().json()).toEqual({ error: "VPortal request failed", code: "response_limit" });
    await safeError(announced, 502);
    const cancel = vi.fn();
    upstream.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(VPORTAL_LIMITS.response));
        controller.enqueue(new Uint8Array(1));
      }, cancel,
    })));
    const chunked = await run();
    expect(await chunked.clone().json()).toEqual({ error: "VPortal request failed", code: "response_limit" });
    await safeError(chunked, 502);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["headers", "body"])("times out stalled upstream %s and aborts the request", async stage => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    upstream.mockImplementation(() => stage === "headers" ? new Promise(() => {}) : Promise.resolve(new Response(new ReadableStream({ cancel }))));
    const pending = run();
    await vi.advanceTimersByTimeAsync(VPORTAL_LIMITS.timeout + 1);
    const response = await pending;
    expect(await response.clone().json()).toEqual({ error: "VPortal request timed out", code: "timeout" });
    await safeError(response, 504);
    expect(upstream.mock.calls[0][1].signal.aborted).toBe(true);
    if (stage === "body") expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds active response buffers and releases capacity after timeout", async () => {
    vi.useFakeTimers();
    upstream.mockImplementation(() => new Promise(() => {}));
    const pending = Array.from({ length: VPORTAL_LIMITS.concurrent }, () => run());
    await vi.advanceTimersByTimeAsync(1);
    const busy = await run();
    expect(busy.headers.get("Retry-After")).toBe("5");
    await safeError(busy, 503);
    expect(upstream).toHaveBeenCalledTimes(VPORTAL_LIMITS.concurrent);
    await vi.advanceTimersByTimeAsync(VPORTAL_LIMITS.timeout);
    for (const response of await Promise.all(pending)) await safeError(response, 504);
    upstream.mockResolvedValueOnce(new Response('{"items":[]}'));
    expect((await run()).status).toBe(200);
  });

  it("releases capacity after transport and JSON failures", async () => {
    upstream.mockRejectedValueOnce(new Error("private failure detail"));
    upstream.mockResolvedValueOnce(new Response("not JSON"));
    for (const response of await Promise.all([run(), run()])) await safeError(response, 502);
    upstream.mockImplementation(async () => new Response('{"items":[]}'));
    for (const response of await Promise.all([run(), run()])) expect(response.status).toBe(200);
  });
});

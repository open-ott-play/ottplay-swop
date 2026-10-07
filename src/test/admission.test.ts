import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../index";

const origin = "https://player.test";
const authorization = `Bearer ${"a".repeat(64)}`;
const installed = { Authorization: authorization, Origin: origin, "X-Swop-Client-Id": "test-client" };

function makeEnv(success = true) {
  const limit = vi.fn().mockResolvedValue({ success });
  const get = vi.fn().mockResolvedValue(null);
  const sessionFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  const idFromName = vi.fn((value: string): string => value);
  const env = {
    PUBLIC_BASE_URL: "https://swop.test",
    INSTALLATION_CREDENTIALS_JSON: JSON.stringify([
      { id: "player-host", token: "a".repeat(64), origins: [origin] },
      { id: "second-host", token: "b".repeat(64), origins: ["https://second.test"] },
    ]),
    REQUEST_RATE_LIMIT: { limit },
    SWOP: { get },
    SESSIONS: { idFromName, get: vi.fn(() => ({ fetch: sessionFetch })) },
  } as unknown as Env;
  return { env, limit, get, sessionFetch, idFromName };
}

function unreadableRequest(path: string, headers: Record<string, string> = {}, rejectCancel = false) {
  const pull = vi.fn(() => { throw new Error("Body must not be read before rejection"); });
  const cancel = vi.fn(() => rejectCancel ? Promise.reject(new Error("cancel failure")) : new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  const request = new Request("https://swop.test" + path, {
    method: "POST", headers, body, duplex: "half",
  } as RequestInit);
  return { request, pull, cancel };
}

function expectNoStateAccess(context: ReturnType<typeof makeEnv>) {
  expect(context.get).not.toHaveBeenCalled();
  expect(context.sessionFetch).not.toHaveBeenCalled();
}

describe("SWOP admission before body reads", () => {
  it.each([
    ["public submit", "/submit", {}, "ip:local"],
    ["installed create", "/session", installed, "installation:player-host:ip:local"],
    ["installed poll", "/val", installed, "installation:player-host:ip:local"],
  ] as const)("rejects exhausted %s without reading or awaiting stream cancellation", async (_name, path, headers, key) => {
    const context = makeEnv(false);
    const { request, pull, cancel } = unreadableRequest(path, headers);
    const response = await worker.fetch(request, context.env);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(context.limit).toHaveBeenCalledExactlyOnceWith({ key });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expectNoStateAccess(context);
  });

  it.each([
    [{ ...installed, Authorization: "Bearer invalid" }, 401],
    [{ ...installed, Origin: "https://foreign.test" }, 403],
  ] as const)("rejects invalid installation headers before reading the body", async (headers, status) => {
    const context = makeEnv();
    const { request, pull, cancel } = unreadableRequest("/session", headers, true);
    const response = await worker.fetch(request, context.env);
    expect(response.status).toBe(status);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(context.limit).toHaveBeenCalledExactlyOnceWith({ key: "ip:local" });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expectNoStateAccess(context);
  });

  it("fails closed on a missing rate binding without reading the body", async () => {
    const context = makeEnv();
    delete (context.env as Partial<Env>).REQUEST_RATE_LIMIT;
    const { request, pull, cancel } = unreadableRequest("/session", installed);
    expect((await worker.fetch(request, context.env)).status).toBe(503);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expectNoStateAccess(context);
  });

  it("contains rate binding errors without reading the body or exposing the error", async () => {
    const context = makeEnv();
    context.limit.mockRejectedValue(new Error("private binding detail"));
    const { request, pull, cancel } = unreadableRequest("/session", installed);
    const response = await worker.fetch(request, context.env);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal error" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expectNoStateAccess(context);
  });

  it.each([false, true])("charges oversized requests before body admission (quota success=%s)", async success => {
    const context = makeEnv(success);
    const { request, pull, cancel } = unreadableRequest("/submit", { "Content-Length": "65537" });
    expect((await worker.fetch(request, context.env)).status).toBe(success ? 413 : 429);
    expect(context.limit).toHaveBeenCalledExactlyOnceWith({ key: "ip:local" });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expectNoStateAccess(context);
  });

  it("rejects an oversized streamed body without awaiting cancellation", async () => {
    const context = makeEnv();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel,
    }, { highWaterMark: 0 });
    const request = new Request("https://swop.test/submit", { method: "POST", body, duplex: "half" } as RequestInit);
    expect((await worker.fetch(request, context.env)).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expectNoStateAccess(context);
  });

  it("preserves the installation/IP quota across owner IDs and keeps installations separate", async () => {
    const context = makeEnv(false);
    for (const headers of [
      installed,
      { ...installed, "X-Swop-Client-Id": "other-client" },
      { Authorization: authorization, Origin: origin },
      { ...installed, "X-Swop-Client-Id": "!invalid" },
      { ...installed, Authorization: `Bearer ${"b".repeat(64)}`, Origin: "https://second.test" },
    ]) {
      const { request, pull } = unreadableRequest("/session", headers);
      expect((await worker.fetch(request, context.env)).status).toBe(429);
      expect(pull).not.toHaveBeenCalled();
    }
    expect(context.limit.mock.calls.map(([input]) => input.key)).toEqual([
      ...Array(4).fill("installation:player-host:ip:local"), "installation:second-host:ip:local",
    ]);
    expectNoStateAccess(context);
  });

  it("still requires a valid owner after admission and never falls back to the allowlist", async () => {
    const context = makeEnv();
    const response = await worker.fetch(new Request("https://swop.test/val", {
      method: "POST", headers: { Authorization: authorization, Origin: origin }, body: JSON.stringify({ code: "ABCDEF", clientId: "!invalid" }),
    }), context.env);
    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(context.limit).toHaveBeenCalledExactlyOnceWith({ key: "installation:player-host:ip:local" });
    expectNoStateAccess(context);
  });

  it("accepts a normal body-owned session after one quota check and retains credential binding", async () => {
    const context = makeEnv();
    const response = await worker.fetch(new Request("https://swop.test/session", {
      method: "POST", headers: { Authorization: authorization, Origin: origin },
      body: JSON.stringify({ clientId: "body-client", caption: "TV", draft: "input" }),
    }), context.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(context.limit).toHaveBeenCalledExactlyOnceWith({ key: "installation:player-host:ip:local" });
    expect(context.get).not.toHaveBeenCalled();
    expect(context.sessionFetch).toHaveBeenCalledOnce();
    const session = await context.sessionFetch.mock.calls[0][0].json();
    expect(session).toMatchObject({ installationId: "player-host", clientId: "body-client", caption: "TV", draft: "input" });
    expect(session.sessionTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(session.submitTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(session.sessionTokenHash).not.toBe(session.submitTokenHash);
  });
});

const externalHost = "swop.test";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function countExternal(request: Request, env: Env) {
  const originalClone = Request.prototype.clone;
  const originalJson = Request.prototype.json;
  let clones = 0;
  let jsons = 0;
  const cloneSpy = vi.spyOn(Request.prototype, "clone").mockImplementation(function (this: Request) {
    const cloned = originalClone.call(this);
    if (new URL(this.url).hostname === externalHost) clones += 1;
    return cloned;
  });
  const jsonSpy = vi.spyOn(Request.prototype, "json").mockImplementation(async function (this: Request) {
    const external = new URL(this.url).hostname === externalHost;
    try {
      return await originalJson.call(this);
    } finally {
      if (external) jsons += 1;
    }
  });
  try {
    const response = await worker.fetch(request, env);
    return { response, clones, jsons };
  } finally {
    cloneSpy.mockRestore();
    jsonSpy.mockRestore();
  }
}

describe("header presence skips the unused identity body", () => {
  it.each([
    ["primary", { "X-Swop-Client-Id": "primary-id", "X-Ottplay-Client-Id": "fallbackid" }, { clientId: "body-client" }, "primary-id", 200, 0, 1],
    ["fallback", { "X-Ottplay-Client-Id": "fallbackid" }, { clientId: "body-client" }, "fallbackid", 200, 0, 1],
    ["conflict", { "X-Swop-Client-Id": "primary-id", "X-Ottplay-Client-Id": "fallbackid" }, { clientId: "body-client" }, "primary-id", 200, 0, 1],
    ["empty primary", { "X-Swop-Client-Id": "", "X-Ottplay-Client-Id": "fallbackid" }, { clientId: "body-client" }, "<generated>", 200, 0, 1],
    ["body only", {}, { clientId: "body-client" }, "body-client", 200, 1, 2],
    ["absent", {}, {}, "<generated>", 200, 1, 2],
    ["invalid", { "X-Swop-Client-Id": "bad", "X-Ottplay-Client-Id": "fallbackid" }, { clientId: "body-client" }, "<rejected>", 401, 0, 0],
  ] as const)("%s binds the selected client and counts only the external fixture", async (_name, extra, fields, expected, status, clones, jsons) => {
    const context = makeEnv();
    const body = JSON.stringify({ ...fields, caption: "TV", draft: "input" });
    const counted = await countExternal(new Request("https://swop.test/session", {
      method: "POST",
      headers: { Authorization: authorization, Origin: origin, "Content-Type": "application/json", ...extra },
      body,
    }), context.env);
    expect(counted.clones).toBe(clones);
    expect(counted.jsons).toBe(jsons);
    expect(counted.response.status).toBe(status);
    expect(context.get).not.toHaveBeenCalled();
    if (status === 401) {
      expect(counted.response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(await counted.response.json()).toEqual({ error: "missing client id" });
      expect(context.sessionFetch).not.toHaveBeenCalled();
      return;
    }
    expect(counted.response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(context.sessionFetch).toHaveBeenCalledOnce();
    const session = await context.sessionFetch.mock.calls[0][0].json();
    const clientId = expected === "<generated>" ? session.clientId : expected;
    if (expected === "<generated>") {
      expect(session.clientId).toMatch(/^swop_[a-f0-9]{64}$/);
      expect(session.clientId).not.toBe("body-client");
      expect(session.clientId).not.toBe("fallbackid");
    } else {
      expect(session.clientId).toBe(expected);
    }
    expect(session).toMatchObject({ installationId: "player-host", clientId, caption: "TV", draft: "input" });
  });

  it("keeps malformed and absent header-owned bodies on the existing default and null paths", async () => {
    const malformed = makeEnv();
    const bad = await countExternal(new Request("https://swop.test/session", {
      method: "POST",
      headers: { ...installed, "Content-Type": "application/json" },
      body: "{",
    }), malformed.env);
    expect(bad.response.status).toBe(200);
    expect(bad.clones).toBe(0);
    expect(bad.jsons).toBe(1);
    expect(await bad.response.json()).toMatchObject({ clientId: "test-client" });
    expect(await malformed.sessionFetch.mock.calls[0][0].json()).toMatchObject({ clientId: "test-client", caption: "", draft: "" });

    const absent = makeEnv();
    const empty = await countExternal(new Request("https://swop.test/session", {
      method: "POST",
      headers: installed,
    }), absent.env);
    expect(empty.response.status).toBe(200);
    expect(empty.clones).toBe(0);
    expect(await absent.sessionFetch.mock.calls[0][0].json()).toMatchObject({ caption: "", draft: "" });

    const nulled = makeEnv();
    const response = await worker.fetch(new Request("https://swop.test/session", {
      method: "POST",
      headers: { ...installed, "Content-Type": "application/json" },
      body: "null",
    }), nulled.env);
    expect(response.status).toBe(500);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toEqual({ error: "internal error" });
    expect(nulled.sessionFetch).not.toHaveBeenCalled();
  });

  it("preserves value code and token precedence, ready consumption, and handler origin", async () => {
    const headerToken = "b".repeat(64);
    const bodyToken = "c".repeat(64);
    const context = makeEnv();
    const seen: Array<{ code: string; payload: { clientId?: string; sessionTokenHash?: string } }> = [];
    context.sessionFetch.mockImplementation(async (request: Request) => {
      seen.push({ code: String(context.idFromName.mock.calls.at(-1)?.[0]), payload: await request.json() });
      return Response.json({ status: "ready", value: "typed-value" });
    });
    const consumed = await countExternal(new Request("https://swop.test/val?c=abcdef", {
      method: "POST",
      headers: { ...installed, "X-Swop-Session-Token": headerToken, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "ZZZZZZ", sessionToken: bodyToken }),
    }), context.env);
    expect(consumed.clones).toBe(1);
    expect(consumed.jsons).toBe(1);
    expect(consumed.response.status).toBe(200);
    expect(consumed.response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(await consumed.response.json()).toEqual({ status: "ready", value: "typed-value" });
    expect(seen[0].code).toBe("ABCDEF");
    expect(seen[0].payload.clientId).toBe("test-client");
    expect(seen[0].payload.sessionTokenHash).toBe(await sha256Hex(headerToken));

    const emptyHeader = makeEnv();
    const emptySeen: typeof seen = [];
    emptyHeader.sessionFetch.mockImplementation(async (request: Request) => {
      emptySeen.push({ code: String(emptyHeader.idFromName.mock.calls.at(-1)?.[0]), payload: await request.json() });
      return Response.json({ status: "ready", value: "typed-value" });
    });
    const fellThrough = await worker.fetch(new Request("https://swop.test/val?c=", {
      method: "POST",
      headers: { ...installed, "X-Swop-Session-Token": "", "Content-Type": "application/json" },
      body: JSON.stringify({ code: "zzzzzz", sessionToken: bodyToken }),
    }), emptyHeader.env);
    expect(fellThrough.status).toBe(200);
    expect(emptySeen[0].code).toBe("ZZZZZZ");
    expect(emptySeen[0].payload.sessionTokenHash).toBe(await sha256Hex(bodyToken));

    const whitespace = makeEnv();
    const blocked = await worker.fetch(new Request("https://swop.test/val?c=%20", {
      method: "POST",
      headers: { ...installed, "X-Swop-Session-Token": headerToken, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "ZZZZZZ", sessionToken: bodyToken }),
    }), whitespace.env);
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toEqual({ error: "missing c" });
    expect(blocked.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(whitespace.sessionFetch).not.toHaveBeenCalled();

    const wrong = makeEnv();
    let wrongHash = "";
    wrong.sessionFetch.mockImplementation(async (request: Request) => {
      wrongHash = (await request.json()).sessionTokenHash;
      return Response.json({ error: "session token invalid" }, { status: 403 });
    });
    const forbidden = await worker.fetch(new Request("https://swop.test/val?c=ABCDEF", {
      method: "POST",
      headers: { ...installed, "X-Swop-Session-Token": headerToken, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "ABCDEF", sessionToken: bodyToken }),
    }), wrong.env);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "session token invalid" });
    expect(forbidden.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(wrongHash).toBe(await sha256Hex(headerToken));
    expect(wrongHash).not.toBe(await sha256Hex(bodyToken));
  });

  it("still admits every byte before a present header can skip identity parsing", async () => {
    const context = makeEnv();
    let pulls = 0;
    const encoded = [
      new TextEncoder().encode('{"caption":"TV","draft":"inp'),
      new TextEncoder().encode('ut"}'),
    ];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls < encoded.length) controller.enqueue(encoded[pulls]);
        else controller.close();
        pulls += 1;
      },
    }, { highWaterMark: 0 });
    const response = await worker.fetch(new Request("https://swop.test/session", {
      method: "POST",
      headers: installed,
      body,
      duplex: "half",
    } as RequestInit), context.env);
    expect(response.status).toBe(200);
    expect(pulls).toBeGreaterThan(1);
    expect(await context.sessionFetch.mock.calls[0][0].json()).toMatchObject({ clientId: "test-client", caption: "TV", draft: "input" });
  });

  it("still returns the admission read error before client validation", async () => {
    const context = makeEnv();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array([123]));
        else controller.error(new Error("synthetic read error"));
      },
    }, { highWaterMark: 0 });
    const response = await worker.fetch(new Request("https://swop.test/session", {
      method: "POST",
      headers: { ...installed, "X-Swop-Client-Id": "bad" },
      body,
      duplex: "half",
    } as RequestInit), context.env);
    expect(response.status).toBe(500);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toEqual({ error: "internal error" });
    expect(pulls).toBeGreaterThan(1);
    expect(context.limit).toHaveBeenCalledOnce();
    expectNoStateAccess(context);
  });
});

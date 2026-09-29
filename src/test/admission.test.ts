import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../index";

const origin = "https://player.test";
const authorization = `Bearer ${"a".repeat(64)}`;
const installed = { Authorization: authorization, Origin: origin, "X-Swop-Client-Id": "test-client" };

function makeEnv(success = true) {
  const limit = vi.fn().mockResolvedValue({ success });
  const get = vi.fn().mockResolvedValue(null);
  const sessionFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  const env = {
    PUBLIC_BASE_URL: "https://swop.test",
    INSTALLATION_CREDENTIALS_JSON: JSON.stringify([
      { id: "player-host", token: "a".repeat(64), origins: [origin] },
      { id: "second-host", token: "b".repeat(64), origins: ["https://second.test"] },
    ]),
    REQUEST_RATE_LIMIT: { limit },
    SWOP: { get },
    SESSIONS: { idFromName: vi.fn(value => value), get: vi.fn(() => ({ fetch: sessionFetch })) },
  } as unknown as Env;
  return { env, limit, get, sessionFetch };
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

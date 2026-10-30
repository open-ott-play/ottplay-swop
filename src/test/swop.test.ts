import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";

type MockKV = {
  get: vi.Mock;
  put: vi.Mock;
  delete: vi.Mock;
  list: vi.Mock;
};

function createMockKV(): MockKV {
  return {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  };
}

function makeEnv(traits: Record<string, string> = {}): Env {
  const kv = createMockKV();
  return {
    SWOP: kv as unknown as KVNamespace,
    REQUEST_RATE_LIMIT: { limit: vi.fn().mockResolvedValue({ success: true }) },
    PUBLIC_BASE_URL: traits.PUBLIC_BASE_URL ?? "https://swop.test",
    SESSION_TTL_SECONDS: traits.SESSION_TTL_SECONDS ?? "600",
    ADMIN_TOKEN: traits.ADMIN_TOKEN ?? "secret-token",
  } as unknown as Env;
}

function req(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown
): Request {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://swop.test${path}`, init);
}

async function fetch(r: Request, env: Env): Promise<Response> {
  return worker.fetch(r, env);
}

function allowlistClient(env: Env, clientId = "client-1"): void {
  const key = `allow:${clientId}`;
  env.SWOP.get.mockImplementation(async (k: string) => {
    if (k === key) {
      return JSON.stringify({ allowedAt: Date.now() });
    }
    return null;
  });
}

describe("Swop Worker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("JSON request shape", () => {
    it.each(["", "{"])("preserves default session creation for an empty or unreadable body", async (body) => {
      const env = makeEnv();
      allowlistClient(env);
      const sessionFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
      env.SESSIONS = {
        idFromName: vi.fn(),
        get: vi.fn().mockReturnValue({ fetch: sessionFetch }),
      } as unknown as DurableObjectNamespace;
      const response = await fetch(new Request("https://swop.test/session", {
        method: "POST", headers: { "X-Swop-Client-Id": "client-1" }, body,
      }), env);
      expect(response.status).toBe(200);
      expect(await sessionFetch.mock.calls[0][0].json()).toMatchObject({
        clientId: "client-1", caption: "", draft: "", ttl: 600,
      });
    });

    it.each([null, [], ["value"], "value", 1, false])(
      "rejects a non-object JSON body without mutating session or client storage: %j", async (body) => {
        const env = makeEnv();
        allowlistClient(env);
        const sessionFetch = vi.fn();
        env.SESSIONS = {
          idFromName: vi.fn(),
          get: vi.fn().mockReturnValue({ fetch: sessionFetch }),
        } as unknown as DurableObjectNamespace;
        for (const [path, headers] of [
          ["/session", { "X-Swop-Client-Id": "client-1" }],
          ["/submit", {}],
          ["/admin/clients", { Authorization: "Bearer secret-token" }],
        ] as const) {
          const response = await fetch(req("POST", path, headers, body), env);
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: "JSON object required" });
        }
        expect(sessionFetch).not.toHaveBeenCalled();
        expect(env.SWOP.put).not.toHaveBeenCalled();
        expect(env.SWOP.delete).not.toHaveBeenCalled();
      }
    );
  });

  describe("Authorization and deployment gates", () => {
    it("requires client identity before accessing session storage", async () => {
      const env = makeEnv();
      expect((await fetch(req("POST", "/session"), env)).status).toBe(401);
      expect((await fetch(req("GET", "/val?c=ABCDEF", { "X-Swop-Client-Id": "unknown-client" }), env)).status).toBe(403);
    });
    it("fails closed if rate limiting is not bound", async () => {
      const env = makeEnv();
      delete env.REQUEST_RATE_LIMIT;
      expect((await fetch(req("POST", "/session"), env)).status).toBe(503);
      expect(env.SWOP.get).not.toHaveBeenCalled();
    });
    it("fails closed if atomic storage is not bound", async () => {
      const env = makeEnv();
      allowlistClient(env);
      expect((await fetch(req("POST", "/session", { "X-Swop-Client-Id": "client-1" }), env)).status).toBe(503);
      expect(env.SWOP.put).not.toHaveBeenCalled();
    });
    it("returns retryable 429 before reading or mutating storage", async () => {
      const env = makeEnv();
      env.REQUEST_RATE_LIMIT.limit.mockResolvedValue({ success: false });
      const response = await fetch(req("POST", "/submit", {}, { code: "ABCDEF", value: "secret" }), env);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(env.SWOP.get).not.toHaveBeenCalled();
      expect(env.SWOP.put).not.toHaveBeenCalled();
    });
  });

  describe("Admin", () => {
    it("list clients returns 503 without admin token", async () => {
      const env = makeEnv({ ADMIN_TOKEN: "" });
      const res = await fetch(req("GET", "/admin/clients"), env);
      expect(res.status).toBe(503);
    });

    it("create and list client", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      kv.get.mockImplementation(async () => null);
      kv.put.mockImplementation(async () => {});
      const res = await fetch(
        req(
          "POST",
          "/admin/clients",
          { Authorization: "Bearer secret-token" },
          { clientId: "new-client", note: "test" }
        ),
        env
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { ok: boolean; clientId: string };
      expect(body.ok).toBe(true);
      expect(body.clientId).toBe("new-client");
    });

    it("overlaps a bounded number of metadata reads and keeps list order", async () => {
      vi.useFakeTimers();
      try {
        const env = makeEnv();
        const kv = env.SWOP as MockKV;
        const keys = Array.from({ length: 11 }, (_, index) => ({ name: `allow:client-${index}` }));
        kv.list.mockResolvedValue({ keys, list_complete: false, cursor: "next-page" });
        let active = 0;
        let maximum = 0;
        const completed: number[] = [];
        kv.get.mockImplementation(async (key: string) => {
          const index = Number(key.slice("allow:client-".length));
          maximum = Math.max(maximum, ++active);
          await new Promise((resolve) => setTimeout(resolve, 4 - (index % 4)));
          active--;
          completed.push(index);
          if (index === 2) return null;
          if (index === 5) return "invalid JSON";
          if (index === 8) return "null";
          return JSON.stringify({ allowedAt: index, note: `note-${index}` });
        });
        const pending = fetch(
          req("GET", "/admin/clients", { Authorization: "Bearer secret-token" }), env
        );
        await vi.runAllTimersAsync();
        const res = await pending;
        expect(res.status).toBe(200);
        expect(maximum).toBeGreaterThan(1);
        expect(maximum).toBeLessThanOrEqual(4);
        expect(active).toBe(0);
        expect(kv.get).toHaveBeenCalledTimes(keys.length);
        expect(completed).not.toEqual(keys.map((_, index) => index));
        expect(await res.json()).toEqual({
          clients: keys.map((_, index) => ({
            clientId: `client-${index}`,
            ...([2, 5, 8].includes(index) ? {} : { allowedAt: index, note: `note-${index}` }),
          })),
          list_complete: false,
          cursor: "next-page",
        });
        expect(kv.list).toHaveBeenCalledExactlyOnceWith({ prefix: "allow:", limit: 100 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("hides storage errors and does not start another metadata batch after failure", async () => {
      vi.useFakeTimers();
      try {
        const env = makeEnv();
        const kv = env.SWOP as MockKV;
        kv.list.mockResolvedValue({
          keys: Array.from({ length: 12 }, (_, index) => ({ name: `allow:client-${index}` })),
          list_complete: true,
        });
        let active = 0;
        kv.get.mockImplementation((key: string) => {
          const index = Number(key.slice("allow:client-".length));
          if (index === 2) throw new Error("later listed failure");
          active++;
          return new Promise((resolve) => setTimeout(resolve, index === 0 ? 30 : 1)).then(() => {
            active--;
            if (index === 0) throw new Error("first listed failure");
            return JSON.stringify({ allowedAt: index });
          });
        });
        const pending = fetch(
          req("GET", "/admin/clients", { Authorization: "Bearer secret-token" }), env
        );
        await vi.runAllTimersAsync();
        const res = await pending;
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "internal error" });
        expect(kv.get).toHaveBeenCalledTimes(4);
        expect(active).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns an empty list without reading metadata", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      kv.list.mockResolvedValue({ keys: [], list_complete: true });
      const res = await fetch(
        req("GET", "/admin/clients", { Authorization: "Bearer secret-token" }), env
      );
      expect(await res.json()).toEqual({ clients: [], list_complete: true, cursor: null });
      expect(kv.get).not.toHaveBeenCalled();
    });

    it("enumerates all pages, including an empty incomplete page, using opaque cursors", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      const opaque = "next+/= cursor";
      kv.list.mockResolvedValueOnce({ keys: [], list_complete: false, cursor: opaque })
        .mockResolvedValueOnce({ keys: [{ name: "allow:client-a" }], list_complete: false, cursor: "last" })
        .mockResolvedValueOnce({ keys: [{ name: "allow:client-b" }], list_complete: true, cursor: "" });
      kv.get.mockImplementation(async (key: string) => JSON.stringify({ allowedAt: key.endsWith("a") ? 1 : 2 }));
      let cursor: string | null = null;
      const clients: unknown[] = [];
      for (let page = 0; page < 3; page++) {
        const query = cursor === null ? "" : "?" + new URLSearchParams({ cursor });
        const response = await fetch(req("GET", "/admin/clients" + query,
          { Authorization: "Bearer secret-token" }), env);
        expect(response.status).toBe(200);
        const body = await response.json() as { clients: unknown[]; list_complete: boolean; cursor: string | null };
        expect(body.list_complete).toBe(page === 2);
        clients.push(...body.clients);
        cursor = body.cursor;
      }
      expect(cursor).toBeNull();
      expect(clients).toEqual([{ clientId: "client-a", allowedAt: 1 }, { clientId: "client-b", allowedAt: 2 }]);
      expect(kv.list.mock.calls).toEqual([
        [{ prefix: "allow:", limit: 100 }],
        [{ prefix: "allow:", limit: 100, cursor: opaque }],
        [{ prefix: "allow:", limit: 100, cursor: "last" }],
      ]);
    });

    it.each(["", "x".repeat(4097), "bad\u0000cursor", "bad\nvalue"])(
      "rejects invalid cursor input before accessing storage", async (cursor) => {
        const env = makeEnv();
        const response = await fetch(req("GET", "/admin/clients?" + new URLSearchParams({ cursor }),
          { Authorization: "Bearer secret-token" }), env);
        expect(response.status).toBe(400);
        expect(env.SWOP.list).not.toHaveBeenCalled();
        expect(env.SWOP.get).not.toHaveBeenCalled();
      });

    it("requires admin authentication on continuation pages and rejects duplicate cursors", async () => {
      const env = makeEnv();
      const path = "/admin/clients?cursor=first&cursor=second";
      expect((await fetch(req("GET", path), env)).status).toBe(401);
      expect((await fetch(req("GET", path, { Authorization: "Bearer secret-token" }), env)).status).toBe(400);
      expect(env.SWOP.list).not.toHaveBeenCalled();
    });

    it.each([undefined, "", "same", "bad\u0000cursor", "x".repeat(4097)])(
      "rejects broken or repeated storage cursors without looping", async (cursor) => {
        const env = makeEnv();
        const kv = env.SWOP as MockKV;
        kv.list.mockResolvedValue({ keys: [], list_complete: false, cursor });
        const response = await fetch(req("GET", "/admin/clients?cursor=same",
          { Authorization: "Bearer secret-token" }), env);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "internal error" });
        expect(kv.list).toHaveBeenCalledTimes(1);
        expect(kv.get).not.toHaveBeenCalled();
      });

    it.each([
      { keys: [], list_complete: undefined },
      { keys: Array.from({ length: 101 }, (_, index) => ({ name: `allow:client-${index}` })), list_complete: true },
    ])("rejects invalid or oversized provider pages before reading metadata", async (page) => {
      const env = makeEnv();
      env.SWOP.list.mockResolvedValue(page);
      const response = await fetch(req("GET", "/admin/clients",
        { Authorization: "Bearer secret-token" }), env);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal error" });
      expect(env.SWOP.list).toHaveBeenCalledTimes(1);
      expect(env.SWOP.get).not.toHaveBeenCalled();
    });

    it("delete client", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      kv.get.mockImplementation(async (k: string) => {
        if (k === "allow:client-1") {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        return null;
      });
      kv.delete.mockImplementation(async () => {});
      const res = await fetch(
        req("DELETE", "/admin/clients?id=client-1", { Authorization: "Bearer secret-token" }),
        env
      );
      expect(res.status).toBe(204);
    });
  });

  describe("CORS and health", () => {
    it("OPTIONS returns 204 with CORS headers", async () => {
      const env = makeEnv();
      const res = await fetch(req("OPTIONS", "/"), env);
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("GET /health returns ok", async () => {
      const env = makeEnv();
      const res = await fetch(req("GET", "/health"), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("returns 404 for unknown path", async () => {
      const env = makeEnv();
      const res = await fetch(req("GET", "/nope"), env);
      expect(res.status).toBe(404);
    });
  });
});

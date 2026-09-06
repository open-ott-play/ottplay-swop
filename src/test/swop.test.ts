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

  describe("POST /session", () => {
    it("creates a session for allowlisted client", async () => {
      const env = makeEnv();
      allowlistClient(env);
      const res = await fetch(req("POST", "/session", { "X-Swop-Client-Id": "client-1" }), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { code: string; url: string; expiresIn: number };
      expect(body.code).toMatch(/^[A-Z2-9]{6}$/);
      expect(body.url).toContain(body.code);
      expect(body.expiresIn).toBe(600);
      expect(env.SWOP.put).toHaveBeenCalledWith(
        `sess:${body.code}`,
        expect.any(String),
        expect.objectContaining({ expirationTtl: 600 })
      );
    });

    it("returns 401 without client id", async () => {
      const env = makeEnv();
      const res = await fetch(req("POST", "/session"), env);
      expect(res.status).toBe(401);
    });

    it("returns 403 for non-allowlisted client", async () => {
      const env = makeEnv();
      // No allowlist setup - all get return null
      const res = await fetch(
        req("POST", "/session", { "X-Swop-Client-Id": "valid-client-id" }),
        env
      );
      expect(res.status).toBe(403);
    });

    it("respects custom SESSION_TTL_SECONDS", async () => {
      const env = makeEnv({ SESSION_TTL_SECONDS: "300" });
      allowlistClient(env);
      const res = await fetch(req("POST", "/session", { "X-Swop-Client-Id": "client-1" }), env);
      const body = (await res.json()) as { expiresIn: number };
      expect(body.expiresIn).toBe(300);
    });
  });

  describe("POST /submit", () => {
    it("submits a value for a waiting session", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      const code = "ABC123";
      kv.get.mockImplementation(async (k: string) => {
        if (k === `sess:${code}`) {
          return JSON.stringify({
            status: "waiting",
            caption: "Test",
            draft: "",
            createdAt: Date.now(),
            clientId: "client-1",
          });
        }
        if (k.startsWith("allow:")) {
          return JSON.stringify({ allowedAt: Date.now() }); // allowlisted
        }
        return null;
      });
      const res = await fetch(req("POST", "/submit", {}, { code, value: "hello" }), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; status: string };
      expect(body.ok).toBe(true);
      expect(body.status).toBe("ready");
    });

    it("returns 410 when session is gone", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      kv.get.mockImplementation(async (k: string) => {
        if (k.startsWith("allow:")) {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        return null;
      });
      const res = await fetch(req("POST", "/submit", {}, { code: "MISSING", value: "hi" }), env);
      expect(res.status).toBe(410);
    });

    it("returns 409 when already submitted", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      const code = "ABC123";
      kv.get.mockImplementation(async (k: string) => {
        if (k === `sess:${code}`) {
          return JSON.stringify({ status: "ready", value: "old" });
        }
        if (k.startsWith("allow:")) {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        return null;
      });
      const res = await fetch(req("POST", "/submit", {}, { code, value: "new" }), env);
      expect(res.status).toBe(409);
    });

    it("returns 400 for missing fields", async () => {
      const env = makeEnv();
      const res = await fetch(req("POST", "/submit", {}, { code: "" }), env);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /val polling", () => {
    it("returns waiting status", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      const code = "ABC123";
      kv.get.mockImplementation(async (k: string) => {
        if (k === `sess:${code}`) {
          return JSON.stringify({
            status: "waiting",
            caption: "Test",
            draft: "",
            createdAt: Date.now(),
            clientId: "client-1",
          });
        }
        if (k.startsWith("allow:")) {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        return null;
      });
      const res = await fetch(
        req("GET", `/val?c=${code}`, { "X-Swop-Client-Id": "client-1" }),
        env
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("waiting");
    });

    it("returns ready status and value, deleting the session", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      const code = "ABC123";
      let deleted = false;
      kv.get.mockImplementation(async (k: string) => {
        if (k === `sess:${code}`) {
          return JSON.stringify({ status: "ready", value: "hello", clientId: "client-1" });
        }
        if (k.startsWith("allow:")) {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        return null;
      });
      kv.delete.mockImplementation(async () => {
        deleted = true;
      });
      const res = await fetch(
        req("GET", `/val?c=${code}`, { "X-Swop-Client-Id": "client-1" }),
        env
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; value: string };
      expect(body.status).toBe("ready");
      expect(body.value).toBe("hello");
      expect(deleted).toBe(true);
    });

    it("returns 403 on client mismatch", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      const code = "ABC123";
      kv.get.mockImplementation(async (k: string) => {
        if (k === `sess:${code}`) {
          return JSON.stringify({ status: "waiting", clientId: "other-client" });
        }
        if (k.startsWith("allow:")) {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        return null;
      });
      const res = await fetch(
        req("GET", `/val?c=${code}`, { "X-Swop-Client-Id": "client-1" }),
        env
      );
      expect(res.status).toBe(403);
    });
  });

  describe("Expiry", () => {
    it("returns gone when KV has no session (expired)", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      kv.get.mockImplementation(async (k: string) => {
        if (k.startsWith("allow:")) {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        return null;
      });
      const res = await fetch(
        req("GET", "/val?c=EXPIRED", { "X-Swop-Client-Id": "client-1" }),
        env
      );
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("gone");
    });

    it("returns 410 on submit after expiry", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      kv.get.mockImplementation(async (k: string) => {
        if (k.startsWith("allow:")) {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        return null;
      });
      const res = await fetch(req("POST", "/submit", {}, { code: "EXPIRED", value: "hi" }), env);
      expect(res.status).toBe(410);
    });

    it("returns gone for form after expiry", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      kv.get.mockImplementation(async (k: string) => {
        if (k.startsWith("allow:")) {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        return null;
      });
      const res = await fetch(req("GET", "/?c=EXPIRED"), env);
      expect(res.status).toBe(410);
    });
  });

  describe("Abandon", () => {
    it("client cannot read another client session", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      const code = "ABC123";
      // Setup: alice creates session, bob tries to read
      kv.get.mockImplementation(async (k: string) => {
        if (k === "allow:client-alice-id") {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        if (k === "allow:client-bob-id") {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        if (k === `sess:${code}`) {
          // This is alice's session
          return JSON.stringify({ status: "waiting", clientId: "client-alice-id" });
        }
        return null;
      });
      const res = await fetch(
        req("GET", `/val?c=${code}`, { "X-Swop-Client-Id": "client-bob-id" }),
        env
      );
      expect(res.status).toBe(403); // bob can't read alice's session
    });

    it("client can submit another client session", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      const code = "ABC123";
      // Setup: alice creates session, bob tries to submit
      kv.get.mockImplementation(async (k: string) => {
        if (k.startsWith("allow:")) {
          return JSON.stringify({ allowedAt: Date.now() });
        }
        if (k === `sess:${code}`) {
          // This is alice's session
          return JSON.stringify({ status: "waiting", clientId: "alice" });
        }
        return null;
      });
      const res = await fetch(
        req("POST", "/submit", { "X-Swop-Client-Id": "bob" }, { code, value: "hijack" }),
        env
      );
      expect(res.status).toBe(200); // submit works (no clientId check)
      const body = (await res.json()) as { ok: boolean; status: string };
      expect(body.ok).toBe(true);
      expect(body.status).toBe("ready");
    });
  });

  describe("GET / form", () => {
    it("returns form page for valid session", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      const code = "ABC123";
      kv.get.mockImplementation(async (k: string) => {
        if (k === `sess:${code}`) {
          return JSON.stringify({
            status: "waiting",
            caption: "Test Caption",
            draft: "hello",
            createdAt: Date.now(),
            clientId: "client-1",
          });
        }
        return null;
      });
      const res = await fetch(req("GET", `/?c=${code}`), env);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Test Caption");
      expect(html).toContain(code);
    });

    it("returns 410 for non-existent session", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      kv.get.mockImplementation(async () => null);
      const res = await fetch(req("GET", "/?c=NOSUCH"), env);
      expect(res.status).toBe(410);
    });

    it("returns 409 for already submitted session", async () => {
      const env = makeEnv();
      const kv = env.SWOP as MockKV;
      const code = "ABC123";
      kv.get.mockImplementation(async (k: string) => {
        if (k === `sess:${code}`) {
          return JSON.stringify({ status: "ready", value: "something" });
        }
        return null;
      });
      const res = await fetch(req("GET", `/?c=${code}`), env);
      expect(res.status).toBe(409);
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

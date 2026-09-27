/** Actual workerd + SQLite Durable Objects; no mocked storage or transaction locks. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

describe("SWOP sessions in workerd", () => {
  let runtime: Miniflare;
  let directory: string;
  let options: Parameters<typeof convertV4MiniflareOptions>[0];
  let caller = 1;
  const installationToken = "a".repeat(64);
  const secondInstallationToken = "b".repeat(64);
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "swop-contract-"));
    const bundled = await build({ entryPoints: ["src/index.ts"], bundle: true, format: "esm", write: false });
    options = {
      name: "swop-contract", stripCfConnectingIp: false, modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2025-09-01",
      durableObjects: { SESSIONS: { className: "SwopSession", useSQLite: true } },
      kvNamespaces: ["SWOP"],
      ratelimits: { REQUEST_RATE_LIMIT: { namespace_id: "1001", simple: { limit: 240, period: 60 } } },
      bindings: {
        PUBLIC_BASE_URL: "https://swop.test", ADMIN_TOKEN: "local-test-admin", SESSION_TTL_SECONDS: "600",
        INSTALLATION_CREDENTIALS_JSON: JSON.stringify([
          { id: "player-host", token: installationToken, origins: ["https://player.test"] },
          { id: "second-host", token: secondInstallationToken, origins: ["https://second.test"] },
          { id: "managed-proxy", token: "c".repeat(64), origins: ["https://managed.test"], originPolicy: "trusted-proxy" },
        ]),
      },
    };
    runtime = new Miniflare({ ...convertV4MiniflareOptions(options), resourcePersistencePath: directory });
    await runtime.ready;
    const kv = await runtime.getKVNamespace("SWOP");
    await kv.put("allow:client-1", JSON.stringify({ allowedAt: Date.now() }));
    await kv.put("allow:client-2", JSON.stringify({ allowedAt: Date.now() }));
  }, 30000);
  beforeEach(() => { caller++; });
  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  function request(method: string, route: string, data?: object, client?: string) {
    return runtime.dispatchFetch("https://swop.test" + route, {
      method,
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": `192.0.2.${caller}`,
        ...(client ? { "X-Swop-Client-Id": client } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  }
  async function create() {
    const response = await request("POST", "/session", { caption: "URL <ТВ>", draft: "draft&" }, "client-1");
    expect(response.status).toBe(200);
    return response.json() as Promise<{ code: string; url: string; expiresIn: number }>;
  }

  function installedRequest(method: string, route: string, data?: object, overrides: Record<string, string> = {}) {
    return runtime.dispatchFetch("https://swop.test" + route, {
      method,
      headers: {
        "Content-Type": "application/json", "CF-Connecting-IP": `192.0.2.${caller}`,
        Authorization: `Bearer ${installationToken}`, Origin: "https://player.test",
        "X-Swop-Client-Id": "unregistered-tv", ...overrides,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  }

  async function createInstalled() {
    const response = await installedRequest("POST", "/session", { caption: "Protected", draft: "private draft" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = await response.json() as { code: string; url: string; sessionToken: string; entryUrl: string; entryCode: string };
    expect(result.sessionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(result.url).not.toContain(result.sessionToken);
    return result;
  }

  it("authorizes arbitrary TVs via installation and isolates read/write capabilities", async () => {
    const { code, url, sessionToken } = await createInstalled();
    const target = new URL(url);
    const token = target.searchParams.get("t")!;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(token).not.toBe(sessionToken);
    expect((await request("GET", `/?c=${code}`)).status).toBe(403);
    const form = await request("GET", target.pathname + target.search);
    expect(form.status).toBe(200);
    expect(form.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await form.text();
    expect(html).toContain("private draft");
    expect(html).not.toContain(sessionToken);
    expect(html).not.toContain(installationToken);
    expect((await request("POST", "/submit", { code, value: "bad" })).status).toBe(403);
    expect((await request("POST", "/submit", { code, value: "bad", token: sessionToken })).status).toBe(403);
    expect((await request("POST", "/submit", { code, value: "Телевизор", token })).status).toBe(200);
    expect((await installedRequest("GET", `/val?c=${code}`)).status).toBe(403);
    expect((await installedRequest("GET", `/val?c=${code}`, undefined, { "X-Swop-Session-Token": token })).status).toBe(403);
    const pollHeaders = { "X-Swop-Session-Token": sessionToken };
    expect(await (await installedRequest("GET", `/val?c=${code}`, undefined, pollHeaders)).json()).toEqual({ status: "ready", value: "Телевизор" });
    expect(await (await installedRequest("GET", `/val?c=${code}`, undefined, pollHeaders)).json()).toEqual({ status: "gone" });
    expect((await request("POST", "/submit", { code, value: "replayed", token })).status).toBe(410);
  });

  it("shows a plain manual code form at the entry URL and accepts a normalized TV code", async () => {
    const root = await request("GET", "/");
    expect(root.status).toBe(200);
    expect(root.headers.get("Cache-Control")).toBe("no-store");
    const landing = await root.text();
    expect(landing).toContain('name="entry"');
    expect(landing).toContain('method="get"');
    expect(landing).toContain("12-character code");
    const { code, url, sessionToken, entryUrl, entryCode } = await createInstalled();
    expect(entryUrl).toBe("https://swop.test/");
    expect(entryCode).toMatch(/^[A-HJ-NP-Z2-9]{6}-[A-HJ-NP-Z2-9]{6}$/);
    expect(entryCode.slice(0, 6)).toBe(code);
    const entered = entryCode.toLowerCase().replace("-", " \t");
    const form = await request("GET", "/?entry=" + encodeURIComponent(entered));
    expect(form.status).toBe(200);
    const body = await form.text();
    expect(body).toContain("private draft");
    expect(body).not.toContain(sessionToken);
    expect(body).not.toContain(new URL(url).searchParams.get("t"));
    expect(body).toContain(`entryCode: "${entryCode.replace("-", "")}"`);
    expect((await request("POST", "/submit", { code, entryCode: entered, value: "Manual TV text" })).status).toBe(200);
    expect((await request("POST", "/submit", { code, entryCode, value: "replay" })).status).toBe(403);
    expect(await (await installedRequest("GET", `/val?c=${code}`, undefined, { "X-Swop-Session-Token": sessionToken })).json()).toEqual({ status: "ready", value: "Manual TV text" });
    expect(await (await installedRequest("GET", `/val?c=${code}`, undefined, { "X-Swop-Session-Token": sessionToken })).json()).toEqual({ status: "gone" });
  });

  function incorrectEntry(entryCode: string): string {
    return entryCode.slice(0, -1) + (entryCode.endsWith("A") ? "B" : "A");
  }

  it("counts failed manual form and submit attempts together without resetting on a valid form", async () => {
    const { code, entryCode, url, sessionToken } = await createInstalled();
    const wrong = incorrectEntry(entryCode);
    for (let i = 0; i < 4; i++) expect((await request("GET", `/?entry=${wrong}`)).status).toBe(400);
    expect((await request("GET", `/?entry=${entryCode}`)).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await request("POST", "/submit", { code, entryCode: wrong, value: "wrong" })).status).toBe(403);
    }
    const locked = await request("GET", `/?entry=${entryCode}`);
    expect(locked.status).toBe(400);
    expect(await locked.text()).not.toContain("private draft");
    expect((await request("POST", "/submit", { code, entryCode, value: "locked" })).status).toBe(403);
    const qr = new URL(url);
    expect((await request("GET", qr.pathname + qr.search)).status).toBe(200);
    expect((await request("POST", "/submit", { code, token: qr.searchParams.get("t"), value: "QR still works" })).status).toBe(200);
    expect(await (await installedRequest("GET", `/val?c=${code}`, undefined, { "X-Swop-Session-Token": sessionToken })).json()).toEqual({ status: "ready", value: "QR still works" });
  });

  it("atomically locks manual entry after eight concurrent failures while preserving QR access", async () => {
    const { code, entryCode, url } = await createInstalled();
    const wrong = incorrectEntry(entryCode);
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      i % 2 ? request("GET", `/?entry=${wrong}`) : request("POST", "/submit", { code, entryCode: wrong, value: "wrong" })));
    expect(attempts.every(response => [400, 403].includes(response.status))).toBe(true);
    expect((await request("GET", `/?entry=${entryCode}`)).status).toBe(400);
    const qr = new URL(url);
    expect((await request("POST", "/submit", { code, token: qr.searchParams.get("t"), value: "Independent QR" })).status).toBe(200);
  });

  it("rejects short, malformed, mismatched, and legacy manual codes without credential downgrade", async () => {
    const { code, entryCode, url } = await createInstalled();
    const token = new URL(url).searchParams.get("t");
    for (const entry of [code, entryCode + "!", entryCode.replace("-", "—"), "ſ" + entryCode.slice(1)]) {
      const invalid = await request("GET", "/?entry=" + encodeURIComponent(entry));
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).not.toContain("private draft");
    }
    expect((await request("GET", `/?c=${code}`)).status).toBe(403);
    expect((await request("POST", "/submit", { code, token, entryCode: incorrectEntry(entryCode), value: "no downgrade" })).status).toBe(403);
    expect((await request("POST", "/submit", { code, token, entryCode: "invalid!", value: "no downgrade" })).status).toBe(403);
    expect((await request("POST", "/submit", { code: "BBBBBB", entryCode, value: "mismatch" })).status).toBe(403);
    expect((await installedRequest("POST", "/val", { code, clientId: "unregistered-tv", sessionToken: entryCode })).status).toBe(403);
    const legacy = await create();
    expect((await request("POST", "/submit", { code: legacy.code, entryCode: legacy.code + "-AAAAAA", value: "legacy downgrade" })).status).toBe(403);
    expect((await request("GET", `/?c=${legacy.code}`)).status).toBe(200);
  });

  it("uses identical manual errors for invalid, expired, and locked sessions", async () => {
    const { entryCode } = await createInstalled();
    const wrong = incorrectEntry(entryCode);
    const invalid = await (await request("GET", `/?entry=${wrong}`)).text();
    const missing = await request("GET", "/?entry=ZZZZZZ-AAAAAA");
    expect(missing.status).toBe(400);
    expect(await missing.text()).toBe(invalid);
    const namespace = await runtime.getDurableObjectNamespace("SESSIONS");
    await namespace.get(namespace.idFromName("EXPRAB")).fetch("https://session.internal/create", {
      method: "POST", body: JSON.stringify({
        installationId: "player-host", clientId: "unregistered-tv", ttl: 0.02,
        entryCodeHash: createHash("sha256").update("EXPRABAAAAAA").digest("hex"),
      }),
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const expired = await request("GET", "/?entry=EXPRAB-AAAAAA");
    expect(expired.status).toBe(400);
    expect(await expired.text()).toBe(invalid);
    expect((await request("POST", "/submit", { code: "EXPRAB", entryCode: "EXPRAB-AAAAAA", value: "expired" })).status).toBe(403);
    for (let i = 0; i < 7; i++) await request("GET", `/?entry=${wrong}`);
    expect(await (await request("GET", `/?entry=${entryCode}`)).text()).toBe(invalid);
  });

  it("denies spoofed origins, invalid credentials, missing browser binding and admin escalation", async () => {
    for (const overrides of [
      { Authorization: "Bearer wrong", Origin: "https://player.test" },
      { Origin: "https://clone.test" },
      { Origin: "null" },
      { Origin: "" },
      { Origin: "https://player.test", "Sec-Fetch-Site": "cross-site" },
    ]) {
      const response = await installedRequest("POST", "/session", {}, overrides);
      expect([401, 403]).toContain(response.status);
    }
    // Knowing the allowed origin alone grants nothing.
    expect((await request("POST", "/session", {}, "unregistered-tv")).status).toBe(403);
    expect((await installedRequest("GET", "/admin/clients")).status).toBe(401);
    expect((await installedRequest("POST", "/session", {}, { Origin: "", Referer: "https://player.test/tv" })).status).toBe(200);
    // Never downgrade to legacy allowlist when a bad installation token is supplied.
    expect((await installedRequest("POST", "/session", {}, { Authorization: "Bearer wrong", "X-Swop-Client-Id": "client-1" })).status).toBe(401);
  });

  it("binds capabilities to both installation and client and prevents legacy downgrade", async () => {
    const { code, sessionToken } = await createInstalled();
    const poll = { "X-Swop-Session-Token": sessionToken };
    expect((await installedRequest("GET", `/val?c=${code}`, undefined, {
      ...poll, Authorization: `Bearer ${secondInstallationToken}`, Origin: "https://second.test",
    })).status).toBe(403);
    expect((await installedRequest("GET", `/val?c=${code}`, undefined, { ...poll, "X-Swop-Client-Id": "other-tv-device" })).status).toBe(403);
    const kv = await runtime.getKVNamespace("SWOP");
    await kv.put("allow:unregistered-tv", JSON.stringify({ allowedAt: Date.now() }));
    expect((await request("GET", `/val?c=${code}`, undefined, "unregistered-tv")).status).toBe(403);
    expect(await (await installedRequest("GET", `/val?c=${code}`, undefined, poll)).json()).toEqual({ status: "waiting" });
  });

  it("consumes a protected session once under simultaneous replay", async () => {
    const { code, url, sessionToken } = await createInstalled();
    const token = new URL(url).searchParams.get("t")!;
    const submissions = await Promise.all(Array.from({ length: 8 }, (_, i) => request("POST", "/submit", { code, token, value: `text-${i}` })));
    expect(submissions.filter(r => r.status === 200)).toHaveLength(1);
    const polls = await Promise.all(Array.from({ length: 8 }, async () =>
      (await installedRequest("GET", `/val?c=${code}`, undefined, { "X-Swop-Session-Token": sessionToken })).json() as Promise<{ status: string }>));
    expect(polls.filter(r => r.status === "ready")).toHaveLength(1);
    expect(polls.filter(r => r.status === "gone")).toHaveLength(7);
  });

  it("supports proxy transports that preserve JSON bodies but remove custom client headers", async () => {
    const headers = { "X-Swop-Client-Id": "bad" };
    // An explicitly invalid header never downgrades to the body identity.
    expect((await installedRequest("POST", "/session", { clientId: "body-only-client" }, headers)).status).toBe(401);
    const send = (route: string, body: object) => runtime.dispatchFetch("https://swop.test" + route, {
      method: "POST", headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${installationToken}`,
        Origin: "https://player.test", "CF-Connecting-IP": `192.0.2.${caller}`,
      }, body: JSON.stringify(body),
    });
    const created = await send("/session", { clientId: "body-only-client", caption: "Body transport" });
    expect(created.status).toBe(200);
    const { code, sessionToken } = await created.json() as { code: string; sessionToken: string };
    expect((await send("/val", { code, clientId: "body-only-client" })).status).toBe(403);
    expect(await (await send("/val", { code, clientId: "body-only-client", sessionToken })).json()).toEqual({ status: "waiting" });
    expect((await send("/val", { code, clientId: "another-body-client", sessionToken })).status).toBe(403);
  });

  it("allows missing provenance only for an explicitly trusted proxy credential", async () => {
    const send = (token: string, extra: Record<string, string> = {}) => runtime.dispatchFetch("https://swop.test/session", {
      method: "POST", headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": `192.0.2.${caller}`, ...extra,
      }, body: JSON.stringify({ clientId: "proxy-client" }),
    });
    expect((await send(installationToken)).status).toBe(403);
    const trusted = await send("c".repeat(64));
    expect(trusted.status).toBe(200);
    expect(trusted.headers.get("Access-Control-Allow-Origin")).toBeNull();
    for (const extra of [{ Origin: "https://clone.test" }, { Origin: "null" },
      { Referer: "not-a-valid-url" }, { Referer: "https://clone.test" }, { "Sec-Fetch-Site": "cross-site" }]) {
      expect((await send("c".repeat(64), extra)).status).toBe(403);
    }
    expect((await send("wrong", { Origin: "https://managed.test" })).status).toBe(401);
  });

  it("issues a unique session owner for legacy TVs without secure client-side randomness", async () => {
    const send = (route: string, body: object) => runtime.dispatchFetch("https://swop.test" + route, {
      method: "POST", headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${installationToken}`,
        Origin: "https://player.test", "CF-Connecting-IP": `192.0.2.${caller}`,
      }, body: JSON.stringify(body),
    });
    const response = await send("/session", {});
    expect(response.status).toBe(200);
    const session = await response.json() as { code: string; sessionToken: string; clientId: string };
    expect(session.clientId).toMatch(/^swop_[a-f0-9]{64}$/);
    const another = await (await send("/session", {})).json() as { clientId: string };
    expect(another.clientId).not.toBe(session.clientId);
    expect(await (await send("/val", session)).json()).toEqual({ status: "waiting" });
    expect((await send("/val", { code: session.code, sessionToken: session.sessionToken })).status).toBe(401);
  });

  it("bounds streamed JSON bodies before cloning or parsing them", async () => {
    const huge = "x".repeat(40000);
    expect((await installedRequest("POST", "/session", { draft: huge })).status).toBe(413);
    expect((await installedRequest("POST", "/val", { clientId: huge })).status).toBe(413);
    expect((await request("POST", "/submit", { code: "ABCDEF", value: huge })).status).toBe(413);
    // Existing value limit counts characters, not UTF-8 bytes.
    const { code, url } = await createInstalled();
    const token = new URL(url).searchParams.get("t")!;
    expect((await request("POST", "/submit", { code, token, value: "漢".repeat(8000) })).status).toBe(200);
  });

  it("creates, renders and waits using the existing wire format", async () => {
    const session = await create();
    expect(session.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(session.url).toBe(`https://swop.test/?c=${session.code}`);
    expect(session.expiresIn).toBe(600);
    expect(await (await request("GET", `/val?c=${session.code}`, undefined, "client-1")).json()).toEqual({ status: "waiting" });
    const form = await request("GET", `/?c=${session.code}`);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain("URL &lt;ТВ&gt;");
  });

  it("accepts only one of 32 simultaneous submissions and consumes only once in 32 polls", async () => {
    const { code } = await create();
    const submissions = await Promise.all(Array.from({ length: 32 }, (_, i) => request("POST", "/submit", { code, value: `ТВ-${i}` })));
    expect(submissions.filter(r => r.status === 200)).toHaveLength(1);
    expect(submissions.filter(r => r.status === 409)).toHaveLength(31);
    const winner = submissions.findIndex(r => r.status === 200);
    expect((await request("GET", `/?c=${code}`)).status).toBe(409);
    const polls = await Promise.all(Array.from({ length: 32 }, async () =>
      (await request("GET", `/val?c=${code}`, undefined, "client-1")).json() as Promise<{ status: string; value?: string }>));
    expect(polls.filter(r => r.status === "ready")).toEqual([{ status: "ready", value: `ТВ-${winner}` }]);
    expect(polls.filter(r => r.status === "gone")).toHaveLength(31);
    expect((await request("POST", "/submit", { code, value: "resurrect" })).status).toBe(410);
  });

  it("denies another allowlisted client without consuming the owner's value", async () => {
    const { code } = await create();
    expect((await request("GET", `/val?c=${code}`, undefined, "client-2")).status).toBe(403);
    expect((await request("POST", "/submit", { code, value: "owner-value" })).status).toBe(200);
    expect((await request("GET", `/val?c=${code}`, undefined, "client-2")).status).toBe(403);
    expect(await (await request("GET", `/val?c=${code}`, undefined, "client-1")).json()).toEqual({ status: "ready", value: "owner-value" });
  });

  it("does not read legacy KV session payloads after the storage cutover", async () => {
    const kv = await runtime.getKVNamespace("SWOP");
    await kv.put("sess:OLDABC", JSON.stringify({ status: "ready", value: "legacy", clientId: "client-1" }));
    expect(await (await request("GET", "/val?c=OLDABC", undefined, "client-1")).json()).toEqual({ status: "gone" });
    expect((await request("POST", "/submit", { code: "OLDABC", value: "new" })).status).toBe(410);
  });

  it("persists consume tombstones across a complete workerd restart", async () => {
    const { code } = await create();
    await request("POST", "/submit", { code, value: "once" });
    expect(await (await request("GET", `/val?c=${code}`, undefined, "client-1")).json()).toEqual({ status: "ready", value: "once" });
    const pending = await create();
    await request("POST", "/submit", { code: pending.code, value: "survives-restart" });
    await runtime.dispose();
    runtime = new Miniflare({ ...convertV4MiniflareOptions(options), resourcePersistencePath: directory });
    await runtime.ready;
    expect(await (await request("GET", `/val?c=${code}`, undefined, "client-1")).json()).toEqual({ status: "gone" });
    expect((await request("POST", "/submit", { code, value: "replay" })).status).toBe(410);
    expect(await (await request("GET", `/val?c=${pending.code}`, undefined, "client-1")).json()).toEqual({ status: "ready", value: "survives-restart" });
    const namespace = await runtime.getDurableObjectNamespace("SESSIONS");
    const reserved = await namespace.get(namespace.idFromName(code)).fetch("https://session.internal/create", {
      method: "POST", body: JSON.stringify({ clientId: "client-1", ttl: 600 }),
    });
    expect(reserved.status).toBe(409);
  }, 30000);

  it("enforces expiry in storage even before an alarm is delivered", async () => {
    const namespace = await runtime.getDurableObjectNamespace("SESSIONS");
    const object = namespace.get(namespace.idFromName("EXPIRE"));
    const response = await object.fetch("https://session.internal/create", {
      method: "POST", body: JSON.stringify({ clientId: "client-1", ttl: 0.02 }),
    });
    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await (await request("GET", "/val?c=EXPIRE", undefined, "client-1")).json()).toEqual({ status: "gone" });
    expect((await request("GET", "/?c=EXPIRE")).status).toBe(410);
    expect((await request("POST", "/submit", { code: "EXPIRE", value: "late" })).status).toBe(410);
  });

  it("reserves a code atomically and retains its tombstone until expiry", async () => {
    const namespace = await runtime.getDurableObjectNamespace("SESSIONS");
    const object = namespace.get(namespace.idFromName("COLLID"));
    const reserve = () => object.fetch("https://session.internal/create", {
      method: "POST", body: JSON.stringify({ clientId: "client-1", ttl: 600 }),
    });
    const responses = await Promise.all([reserve(), reserve()]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    await request("POST", "/submit", { code: "COLLID", value: "v" });
    await request("GET", "/val?c=COLLID", undefined, "client-1");
    expect((await reserve()).status).toBe(409);
  });

  it("uses the real rate-limit binding for public code probing", async () => {
    const responses = await Promise.all(Array.from({ length: 260 }, () => request("GET", "/?c=ABSENT")));
    expect(responses.some(r => r.status === 429)).toBe(true);
    expect(responses.every(r => [410, 429].includes(r.status))).toBe(true);
    expect(responses.find(r => r.status === 429)?.headers.get("Retry-After")).toBe("60");
  }, 15000);
});

/** Exercise workerd's actual fetch implementation; do not mock global fetch. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

describe("VPortal outgoing fetch in workerd", () => {
  let runtime: Miniflare;
  const token = "c".repeat(64);
  const endpoint = "http://portal.example/api/v1/";
  const params = { app: "ott-play", key: "test-portal-key", action: "get_categories" };
  let status: number;
  let responseBody: string;
  let calls: { url: string; method: string; body: unknown; authorization: string | null; cookie: string | null; userAgent: string | null }[];

  beforeAll(async () => {
    const bundled = await build({ entryPoints: ["src/index.ts"], bundle: true, format: "esm", write: false });
    runtime = new Miniflare(convertV4MiniflareOptions({
      name: "vportal-runtime", modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2025-09-01",
      ratelimits: { REQUEST_RATE_LIMIT: { namespace_id: "1001", simple: { limit: 240, period: 60 } } },
      bindings: {
        INSTALLATION_CREDENTIALS_JSON: JSON.stringify([
          { id: "player", token, origins: ["https://player.example"], originPolicy: "trusted-proxy" },
        ]),
        VPORTAL_ENDPOINTS_JSON: JSON.stringify([endpoint]),
      },
      outboundService: async request => {
        calls.push({
          url: request.url, method: request.method, body: await request.json(),
          authorization: request.headers.get("Authorization"), cookie: request.headers.get("Cookie"),
          userAgent: request.headers.get("User-Agent"),
        });
        return new Response(responseBody, { status, headers: {
          "Content-Type": "text/html", ...(status >= 300 && status < 400 ? { Location: "https://other.example/collect" } : {}),
        } });
      },
    }));
    await runtime.ready;
  }, 30000);
  beforeEach(() => { status = 200; responseBody = '{"items":[{"title":"TV"}]}'; calls = []; });
  afterAll(async () => { await runtime?.dispose(); });

  function request() {
    return runtime.dispatchFetch("https://swop.example/vportal/api", {
      method: "POST", headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json", Cookie: "private-cookie",
      }, body: JSON.stringify({ url: endpoint, params }),
    });
  }

  it("fetches the allowed upstream using supported runtime options and parses its JSON", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ title: "TV" }] });
    expect(calls).toEqual([{
      url: endpoint, method: "POST", body: params, authorization: null, cookie: null, userAgent: "OTT-play-FOSS/1.0",
    }]);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it.each([301, 302, 307, 308])("rejects HTTP %s without following or sending credentials to a second destination", async redirect => {
    status = redirect;
    responseBody = "test-portal-key private response";
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "VPortal request failed", code: "upstream_http", upstreamStatus: redirect });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(endpoint);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("returns only a sanitized HTTP classification for an upstream rejection", async () => {
    status = 403;
    responseBody = `private ${params.key} ${token}`;
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "VPortal request failed", code: "upstream_http", upstreamStatus: 403 });
  });

  it("classifies non-JSON responses without disclosing their contents", async () => {
    responseBody = `<html>${params.key}</html>`;
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "VPortal request failed", code: "invalid_json" });
  });
});

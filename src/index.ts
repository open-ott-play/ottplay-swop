export interface Env {
  SWOP: KVNamespace;
  PUBLIC_BASE_URL: string;
  SESSION_TTL_SECONDS?: string;
}

type SessionStatus = "waiting" | "ready";

interface SessionRecord {
  status: SessionStatus;
  caption: string;
  draft: string;
  value?: string;
  createdAt: number;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0 O I l
const CODE_LENGTH = 6;
const DEFAULT_TTL = 600;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
      ...CORS_HEADERS,
    },
  });
}

function ttlSeconds(env: Env): number {
  const n = Number(env.SESSION_TTL_SECONDS ?? DEFAULT_TTL);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TTL;
}

function sessKey(code: string): string {
  return `sess:${code.toUpperCase()}`;
}

function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

async function allocateCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = randomCode();
    const existing = await env.SWOP.get(sessKey(code));
    if (existing === null) {
      return code;
    }
  }
  throw new Error("Could not allocate unique session code");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function formPage(code: string, caption: string, draft: string): string {
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
        const res = await fetch("/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: ${JSON.stringify(code)}, value }),
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

async function handleSession(request: Request, env: Env): Promise<Response> {
  let body: { caption?: string; draft?: string } = {};
  try {
    body = (await request.json()) as { caption?: string; draft?: string };
  } catch {
    // empty body ok
  }
  const caption = typeof body.caption === "string" ? body.caption.slice(0, 200) : "";
  const draft = typeof body.draft === "string" ? body.draft.slice(0, 4000) : "";
  const ttl = ttlSeconds(env);
  const code = await allocateCode(env);
  const record: SessionRecord = {
    status: "waiting",
    caption,
    draft,
    createdAt: Date.now(),
  };
  await env.SWOP.put(sessKey(code), JSON.stringify(record), {
    expirationTtl: ttl,
  });
  const base = (env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const url = `${base}/?c=${encodeURIComponent(code)}`;
  return json({ code, url, expiresIn: ttl });
}
async function handleForm(url: URL, env: Env): Promise<Response> {
  const code = (url.searchParams.get("c") || "").trim().toUpperCase();
  if (!code) {
    return html("<!DOCTYPE html><title>Missing code</title><p>Missing session code (?c=).</p>", 400);
  }
  const raw = await env.SWOP.get(sessKey(code));
  if (!raw) {
    return html("<!DOCTYPE html><title>Gone</title><p>Session expired or not found.</p>", 410);
  }
  const record = JSON.parse(raw) as SessionRecord;
  if (record.status === "ready") {
    return html("<!DOCTYPE html><title>Already submitted</title><p>This session already has a value.</p>", 409);
  }
  return html(formPage(code, record.caption, record.draft));
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  let body: { code?: string; value?: string };
  try {
    body = (await request.json()) as { code?: string; value?: string };
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const value = typeof body.value === "string" ? body.value : "";
  if (!code || !value) {
    return json({ error: "code and value are required" }, 400);
  }
  if (value.length > 8000) {
    return json({ error: "value too long" }, 400);
  }
  const key = sessKey(code);
  const raw = await env.SWOP.get(key);
  if (!raw) {
    return json({ error: "session gone", status: "gone" }, 410);
  }
  const record = JSON.parse(raw) as SessionRecord;
  if (record.status === "ready") {
    return json({ error: "already submitted", status: "ready" }, 409);
  }
  const ttl = ttlSeconds(env);
  const next: SessionRecord = {
    ...record,
    status: "ready",
    value,
  };
  await env.SWOP.put(key, JSON.stringify(next), { expirationTtl: ttl });
  return json({ ok: true, status: "ready" });
}

async function handleVal(url: URL, env: Env): Promise<Response> {
  const code = (url.searchParams.get("c") || "").trim().toUpperCase();
  if (!code) {
    return json({ error: "missing c" }, 400);
  }
  const key = sessKey(code);
  const raw = await env.SWOP.get(key);
  if (!raw) {
    return json({ status: "gone" });
  }
  const record = JSON.parse(raw) as SessionRecord;
  if (record.status === "waiting") {
    return json({ status: "waiting" });
  }
  // burn-after-read
  await env.SWOP.delete(key);
  return json({ status: "ready", value: record.value ?? "" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && path === "/health") {
        return json({ ok: true });
      }
      if (request.method === "POST" && path === "/session") {
        return await handleSession(request, env);
      }
      if (request.method === "POST" && path === "/submit") {
        return await handleSubmit(request, env);
      }
      if (request.method === "GET" && path === "/val") {
        return await handleVal(url, env);
      }
      if (request.method === "GET" && path === "/") {
        return await handleForm(url, env);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return json({ error: message }, 500);
    }
  },
};

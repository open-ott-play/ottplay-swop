/** One strongly consistent Durable Object per code; no session reads from KV. */
export interface SessionRecord {
  status: "waiting" | "ready" | "consumed";
  caption?: string;
  draft?: string;
  value?: string;
  clientId?: string;
  installationId?: string;
  sessionTokenHash?: string;
  submitTokenHash?: string;
  entryCodeHash?: string;
  entryFailures?: number;
  expiresAt: number;
}

export class SwopSession {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const operation = new URL(request.url).pathname;
    const input = await request.json() as {
      clientId?: string; caption?: string; draft?: string; value?: string; ttl: number;
      installationId?: string; sessionTokenHash?: string; submitTokenHash?: string;
      entryCodeHash?: string;
    };
    // Only the front Worker can reach this binding. A storage transaction owns
    // every state transition, including allocation, submission and consumption.
    return this.ctx.storage.transaction(async (storage) => {
      const now = Date.now();
      let record = await storage.get<SessionRecord>("session");
      if (record && record.expiresAt <= now) {
        await storage.delete("session");
        record = undefined;
      }
      if (operation === "/create") {
        if (record) return Response.json({ error: "code occupied" }, { status: 409 });
        const next: SessionRecord = {
          status: "waiting", clientId: input.clientId,
          ...(input.installationId ? {
            installationId: input.installationId,
            sessionTokenHash: input.sessionTokenHash,
            submitTokenHash: input.submitTokenHash,
            ...(input.entryCodeHash ? { entryCodeHash: input.entryCodeHash, entryFailures: 0 } : {}),
          } : {}),
          caption: input.caption, draft: input.draft, expiresAt: now + input.ttl * 1000,
        };
        await storage.put("session", next);
        await storage.setAlarm(next.expiresAt);
        return Response.json({ ok: true });
      }
      if (!record || record.status === "consumed") {
        return Response.json(operation === "/submit" ? { error: "session gone", status: "gone" } : { status: "gone" }, { status: operation === "/consume" ? 200 : 410 });
      }
      if (operation === "/form" || operation === "/submit") {
        // The independent QR capability keeps working after manual lockout.
        const validQr = !!record.submitTokenHash && record.submitTokenHash === input.submitTokenHash;
        if (input.entryCodeHash !== undefined) {
          const failures = record.entryFailures ?? 0;
          if (!record.entryCodeHash || failures >= 8 || record.entryCodeHash !== input.entryCodeHash) {
            if (record.entryCodeHash && failures < 8) {
              record = { ...record, entryFailures: failures + 1 };
              await storage.put("session", record);
            }
            return Response.json({ error: "entry code unavailable" }, { status: 403 });
          }
        } else if (!validQr && record.submitTokenHash) {
          return Response.json({ error: "session token invalid" }, { status: 403 });
        }
      }
      if (operation === "/form") {
        if (record.status === "ready") return Response.json({ status: "ready" }, { status: 409 });
        return Response.json({ caption: record.caption, draft: record.draft });
      }
      if (operation === "/submit") {
        if (record.status === "ready") return Response.json({ error: "already submitted", status: "ready" }, { status: 409 });
        const next: SessionRecord = {
          ...record, status: "ready", value: input.value,
          // An installation capability always expires at the original deadline.
          expiresAt: record.installationId ? record.expiresAt : now + input.ttl * 1000,
        };
        await storage.put("session", next);
        await storage.setAlarm(next.expiresAt);
        return Response.json({ ok: true, status: "ready" });
      }
      if (operation === "/consume") {
        if (record.clientId !== input.clientId || record.installationId !== input.installationId) {
          return Response.json({ error: "client mismatch" }, { status: 403 });
        }
        if (record.sessionTokenHash && record.sessionTokenHash !== input.sessionTokenHash) {
          return Response.json({ error: "session token invalid" }, { status: 403 });
        }
        if (record.status === "waiting") return Response.json({ status: "waiting" });
        // Keep only an expiry tombstone: a late request cannot resurrect the
        // payload, and allocation cannot immediately reuse a consumed code.
        await storage.put("session", { status: "consumed", expiresAt: record.expiresAt });
        return Response.json({ status: "ready", value: record.value ?? "" });
      }
      return Response.json({ error: "unknown operation" }, { status: 404 });
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      const record = await storage.get<SessionRecord>("session");
      if (record && record.expiresAt > Date.now()) {
        // A submission may have extended TTL after an earlier alarm was queued.
        await storage.setAlarm(record.expiresAt);
      } else {
        await storage.delete("session");
      }
    });
  }
}

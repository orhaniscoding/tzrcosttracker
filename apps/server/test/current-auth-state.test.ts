import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { users } from "@cost-core/database";
import { buildApp } from "../src/app.js";

const SECRET = { jwtSecret: "test-jwt-secret-very-long-and-secure-1234", masterKey: "test-master-key-32-bytes-long-1234", blindIndexPepper: "test-pepper-for-blind-index-1234" };
const PASSWORD = "Synthetic-Pass-1234";

async function buildFreshApp(): Promise<FastifyInstance> {
  const app = await buildApp({ config: SECRET, dbPath: ":memory:" });
  await app.ready();
  return app;
}
function dbOf(app: FastifyInstance): any { return (app.userRepo as any).db; }
function sign(app: FastifyInstance, payload: Record<string, unknown>): string { try { if (typeof payload.id === 'string' && (payload.id as string).trim().length > 0 && !payload.is2FaPending) { const s: any = (app as any).sessionRepo.createSession(payload.id as string); return (app as any).jwt.sign({ ...payload, sid: s.id, exp: s.expiresAt }); } } catch {} return (app as any).jwt.sign(payload); }
async function createSynthetic(app: FastifyInstance, username: string, role: string) {
  return app.userRepo.createUser({ username, email: username + "@example.test", fullName: "Synthetic User", password: PASSWORD, role: role as any }, app.config.masterKey);
}
function auth(token: string) { return { authorization: "Bearer " + token }; }

describe("current auth state guard", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildFreshApp(); });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); });

  it("allows active valid JWT on GET /api/projects", async () => {
    const u = await createSynthetic(app, "active_user", "viewer");
    const token = sign(app, { id: u.id, username: u.username, role: "viewer" });
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: auth(token) });
    expect(res.statusCode).toBe(200);
  });

  it("rejects same token after deactivation", async () => {
    const u = await createSynthetic(app, "deact_user", "viewer");
    const token = sign(app, { id: u.id, username: u.username, role: "viewer" });
    expect((await app.inject({ method: "GET", url: "/api/projects", headers: auth(token) })).statusCode).toBe(200);
    await dbOf(app).update(users).set({ isActive: false }).where(eq(users.id, u.id));
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: auth(token) });
    expect(res.statusCode).toBe(401);
  });

  it("rejects same token after deletion", async () => {
    const u = await createSynthetic(app, "deleted_user", "viewer");
    const token = sign(app, { id: u.id, username: u.username, role: "viewer" });
    expect((await app.inject({ method: "GET", url: "/api/projects", headers: auth(token) })).statusCode).toBe(200);
    await dbOf(app).delete(users).where(eq(users.id, u.id));
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: auth(token) });
    expect(res.statusCode).toBe(401);
  });

  it("uses current DB role: downgraded admin gets 403 on white-label PUT", async () => {
    const u = await createSynthetic(app, "downgrade_admin", "admin");
    const token = sign(app, { id: u.id, username: u.username, role: "admin" });
    const ok = await app.inject({ method: "PUT", url: "/api/settings/white-label", headers: auth(token), payload: { companyName: "Synthetic Corp" } });
    expect(ok.statusCode).toBe(200);
    await dbOf(app).update(users).set({ role: "viewer" as any }).where(eq(users.id, u.id));
    const res = await app.inject({ method: "PUT", url: "/api/settings/white-label", headers: auth(token), payload: { companyName: "Hijack Corp" } });
    expect(res.statusCode).toBe(403);
  });

  it("rejects missing, empty, nonstring and unknown ids", async () => {
    const u = await createSynthetic(app, "identity_user", "viewer");
    const cases: Array<Record<string, unknown>> = [
      { username: u.username, role: "viewer" },
      { id: "", username: u.username, role: "viewer" },
      { id: "   ", username: u.username, role: "viewer" },
      { id: 123, username: u.username, role: "viewer" },
      { id: "00000000-0000-4000-8000-000000000000", username: "ghost", role: "viewer" },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: "GET", url: "/api/projects", headers: auth(sign(app, payload)) });
      expect(res.statusCode).toBe(401);
    }
  });

  it("rejects 2FA-pending token before minimal state lookup", async () => {
    const u = await createSynthetic(app, "pending_user", "viewer");
    const spy = vi.spyOn(app.userRepo, "getAuthStateById");
    const token = sign(app, { id: u.id, is2FaPending: true });
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: auth(token) });
    expect(res.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed without leaking internals when DB lookup errors", async () => {
    const u = await createSynthetic(app, "dbfail_user", "viewer");
    vi.spyOn(app.userRepo, "getAuthStateById").mockRejectedValue(new Error("boom-secret-internal"));
    const token = sign(app, { id: u.id, username: u.username, role: "viewer" });
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: auth(token) });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("boom-secret-internal");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const CFG={jwtSecret:"test-jwt-secret-very-long-and-secure-1234",masterKey:"test-master-key-32-bytes-long-1234",blindIndexPepper:"test-pepper-for-blind-index-1234",bootstrapToken:"synthetic-bootstrap-token-32chars!"};
const PW="Synthetic-Pass-1234";

async function fresh(){ const a=await buildApp({config:CFG,dbPath:":memory:"}); await a.ready(); return a; }
async function reg(app:FastifyInstance,role:string,token?:string){ return app.inject({method:"POST",url:"/api/auth/register",headers:token?{authorization:"Bearer "+token}:undefined,payload:{username:"pub_"+role,email:role+"@example.test",fullName:"Synthetic User",password:PW,role}}); }
async function login(app:FastifyInstance,u:string){ const r=await app.inject({method:"POST",url:"/api/auth/login",payload:{usernameOrEmail:u,password:PW}}); expect(r.statusCode).toBe(200); return JSON.parse(r.body).token as string; }

describe("public registration closed",()=>{
  let app:FastifyInstance;
  beforeEach(async()=>{ app=await fresh(); });
  afterEach(async()=>{ await app.close(); });

  it("rejects unauthenticated register for every valid role on empty app",async()=>{
    for(const role of ["admin","manager","accountant","auditor","viewer"]){
      const r=await reg(app,role);
      expect(r.statusCode).toBe(403);
      const b=JSON.parse(r.body); expect(b.token).toBeUndefined(); expect(typeof b.error).toBe("string");
    }
    expect(await app.userRepo.listUsers()).toHaveLength(0);
    const s=await app.inject({method:"GET",url:"/api/system/status"});
    expect(s.statusCode).toBe(200); expect(JSON.parse(s.body).needsSetup).toBe(true);
  });

  it("rejects register even with valid admin token and creates no second user",async()=>{
    await app.userRepo.createUser({username:"synth_admin",email:"synth_admin@example.test",fullName:"Synthetic Admin",password:PW,role:"admin"},CFG.masterKey);
    const token=await login(app,"synth_admin");
    const r=await reg(app,"admin",token);
    expect(r.statusCode).toBe(403); expect(JSON.parse(r.body).token).toBeUndefined();
    const users=await app.userRepo.listUsers(); expect(users).toHaveLength(1); expect(users[0].username).toBe("synth_admin");
  });

  it("admin can still create user via /api/auth/users, unauthenticated cannot",async()=>{
    await app.userRepo.createUser({username:"synth_admin",email:"synth_admin@example.test",fullName:"Synthetic Admin",password:PW,role:"admin"},CFG.masterKey);
    const token=await login(app,"synth_admin");
    const payload={username:"managed_user",email:"managed_user@example.test",fullName:"Managed User",password:PW,role:"viewer"};
    const unauth=await app.inject({method:"POST",url:"/api/auth/users",payload});
    expect(unauth.statusCode).toBe(401);
    const ok=await app.inject({method:"POST",url:"/api/auth/users",headers:{authorization:"Bearer "+token},payload});
    expect(ok.statusCode).toBe(201); expect(JSON.parse(ok.body).username).toBe("managed_user");
    expect(await app.userRepo.listUsers()).toHaveLength(2);
  });

  it("system setup still creates admin on empty app and second setup is 403",async()=>{
    const payload={companyName:"Synthetic Co",baseCurrency:"TRY",admin:{username:"setup_admin",fullName:"Setup Admin",email:"setup_admin@example.test",password:PW,pin:"1234"},industryTemplate:"blank"};
    const first=await app.inject({method:"POST",url:"/api/system/setup",headers:{"x-setup-token":"synthetic-bootstrap-token-32chars!"},payload});
    expect(first.statusCode).toBe(201); const b=JSON.parse(first.body); expect(b.user.username).toBe("setup_admin"); expect(b.token).toBeDefined();
    const second=await app.inject({method:"POST",url:"/api/system/setup",headers:{"x-setup-token":"synthetic-bootstrap-token-32chars!"},payload:{...payload,admin:{...payload.admin,username:"setup_admin2",email:"setup_admin2@example.test"}}});
    expect(second.statusCode).toBe(403);
    expect(await app.userRepo.listUsers()).toHaveLength(1);
  });
});

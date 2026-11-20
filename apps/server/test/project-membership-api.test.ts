import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, eq } from 'drizzle-orm';
import { users, projects, projectMemberships, auditLogs, authSessions } from '@cost-core/database';
import { buildApp } from '../src/app.js';
const CFG={jwtSecret:'test-jwt-secret-very-long-and-secure-1234',masterKey:'test-master-key-32-bytes-long-1234',blindIndexPepper:'test-pepper-for-blind-index-1234',bootstrapToken:'synthetic-bootstrap-token-32chars'};
let app: FastifyInstance | undefined;
afterEach(async()=>{if(app){await app.close();app=undefined;}});
const dbOf=(a:any)=>(a.userRepo as any).db;
const raw=(a:any,s:string)=>{dbOf(a).run(sql.raw(s));};
function mkUser(a:any,id:string,role='viewer',active=true){const now=new Date().toISOString();dbOf(a).insert(users).values({id,username:id,email:id+'@example.test',fullName:'Syn',passwordHash:'synthetic-hash',role,isActive:active,createdAt:now,updatedAt:now}).run();return {id,username:id,role,isActive:active};}
function mkProj(a:any,id:string){const now=new Date().toISOString();dbOf(a).insert(projects).values({id,name:'P-'+id,budget:0,currency:'TRY',status:'active',createdAt:now,updatedAt:now}).run();return id;}
function tok(a:any,u:any){const s=a.sessionRepo.createSession(u.id);return {sid:s.id,t:a.jwt.sign({id:u.id,username:u.username,role:u.role,sid:s.id,exp:s.expiresAt})};}
async function fresh(){const a:any=await buildApp({config:CFG,dbPath:':memory:'});await a.ready();app=a;return a;}
const H=(t:string)=>({authorization:'Bearer '+t});
const list=(a:any,t:string)=>a.inject({method:'GET',url:'/api/projects',headers:H(t)});
const ids=(r:any)=>JSON.parse(r.body).map((p:any)=>p.id).sort();
const post=(a:any,t:string,extra:any={})=>a.inject({method:'POST',url:'/api/projects',headers:H(t),payload:Object.assign({name:'Syn'},extra)});
const mem=(a:any,t:string,p:string)=>a.inject({method:'GET',url:'/api/projects/'+p+'/members',headers:H(t)});
const grant=(a:any,t:string,p:string,u:string,extra:any={})=>a.inject({method:'PUT',url:'/api/projects/'+p+'/members/'+u,headers:H(t),payload:extra});
const revoke=(a:any,t:string,p:string,u:string)=>a.inject({method:'DELETE',url:'/api/projects/'+p+'/members/'+u,headers:H(t)});
const cnt=(a:any,tbl:any)=>dbOf(a).select().from(tbl).all().length;
const mrows=(a:any)=>dbOf(a).select().from(projectMemberships).all().map((r:any)=>[r.userId,r.projectId,r.createdAt]).sort();
const arows=(a:any)=>dbOf(a).select().from(auditLogs).all().map((r:any)=>[r.userId,r.action,r.entity,r.entityId]).sort();
function addM(a:any,u:string,p:string){dbOf(a).insert(projectMemberships).values({userId:u,projectId:p,createdAt:new Date().toISOString()}).run();}
function trig(a:any,n:string,s:string){raw(a,'CREATE TRIGGER '+n+' '+s);}
function drop(a:any,n:string){raw(a,'DROP TRIGGER IF EXISTS '+n);}
async function scopeCase(role:string){const a=await fresh();mkProj(a,'p1');mkProj(a,'p2');mkProj(a,'p3');const u=mkUser(a,'u_'+role,role);const t=tok(a,u).t;addM(a,u.id,'p1');const r=await list(a,t);expect(r.statusCode).toBe(200);expect(ids(r)).toEqual(['p1']);expect(r.body).not.toContain('p2');}

describe('project membership api', () => {
  it('admin lists all projects', async () => {
    const a = await fresh(); mkProj(a,'p1'); mkProj(a,'p2');
    const u = mkUser(a,'adm0','admin'); const r = await list(a, tok(a, u).t);
    expect(r.statusCode).toBe(200); expect(ids(r)).toEqual(['p1','p2']);
  });

  for (const role of ['manager','accountant','auditor','viewer']) {
    it('role ' + role + ' sees only assigned project', async () => { await scopeCase(role); });
  }

  it('unassigned nonadmin sees empty list', async () => {
    const a = await fresh(); mkProj(a,'p1'); const u = mkUser(a,'mgr0','manager');
    const r = await list(a, tok(a, u).t); expect(r.statusCode).toBe(200); expect(ids(r)).toEqual([]);
  });

  it('grant and revoke reflect immediately with same token', async () => {
    const a = await fresh(); mkProj(a,'p1'); mkProj(a,'p2');
    const adm = mkUser(a,'adm3','admin'); const u = mkUser(a,'mgr3','manager'); addM(a, u.id, 'p1');
    const at = tok(a, adm).t; const ut = tok(a, u).t;
    expect(ids(await list(a, ut))).toEqual(['p1']);
    const g = await grant(a, at, 'p2', u.id); expect(g.statusCode).toBe(200); expect(JSON.parse(g.body).changed).toBe(true);
    expect(ids(await list(a, ut))).toEqual(['p1','p2']);
    const d = await revoke(a, at, 'p1', u.id); expect(d.statusCode).toBe(200); expect(JSON.parse(d.body).changed).toBe(true);
    expect(ids(await list(a, ut))).toEqual(['p2']);
  });

  it('nonadmin denied project create, members read, self grant and revoke', async () => {
    const a = await fresh(); mkProj(a,'p1');
    const adm = mkUser(a,'adm4','admin'); const other = mkUser(a,'oth4','accountant'); addM(a, other.id, 'p1');
    const at = tok(a, adm).t;
    for (const role of ['manager','accountant','auditor','viewer']) {
      const u = mkUser(a,'r_'+role, role); const t = tok(a, u).t; addM(a, u.id, 'p1');
      expect((await post(a, t, {name:'X',role:'admin',id:'p1'})).statusCode).toBe(403);
      expect((await mem(a, t, 'p1')).statusCode).toBe(403);
      expect((await grant(a, t, 'p1', u.id, {role:'admin',userId:u.id})).statusCode).toBe(403);
      expect((await revoke(a, t, 'p1', u.id)).statusCode).toBe(403);
    }
    expect(cnt(a, projects)).toBe(1); expect(mrows(a)).toHaveLength(5);
    expect((await grant(a, at, 'p1', adm.id)).statusCode).toBe(200);
  });

  it('members response has exactly 3 fields and no user secrets', async () => {
    const a = await fresh(); mkProj(a,'p1'); const adm = mkUser(a,'adm5','admin'); const u = mkUser(a,'usr5','viewer'); addM(a, u.id, 'p1');
    const r = await mem(a, tok(a,adm).t, 'p1'); expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body); expect(body).toHaveLength(1);
    expect(Object.keys(body[0]).sort()).toEqual(['createdAt','projectId','userId']);
    for (const s of ['synthetic-hash','password','pin','twoFactor','email']) { expect(r.body).not.toContain(s); }
  });

  it('repeat grant and repeat revoke do not rewrite timestamp or audit', async () => {
    const a = await fresh(); mkProj(a,'p1'); const adm = mkUser(a,'adm6','admin'); const u = mkUser(a,'usr6','viewer');
    const t = tok(a,adm).t;
    expect(JSON.parse((await grant(a, t, 'p1', u.id)).body).changed).toBe(true);
    const ts = mrows(a)[0][2]; const n1 = cnt(a, auditLogs);
    expect(JSON.parse((await grant(a, t, 'p1', u.id)).body).changed).toBe(false);
    expect(mrows(a)[0][2]).toBe(ts); expect(cnt(a,auditLogs)).toBe(n1);
    expect(JSON.parse((await revoke(a, t, 'p1', u.id)).body).changed).toBe(true);
    const n2 = cnt(a, auditLogs);
    expect(JSON.parse((await revoke(a, t, 'p1', u.id)).body).changed).toBe(false);
    expect(cnt(a,auditLogs)).toBe(n2);
  });

  it('invalid ids are 400 and unknown ids 404 without writes', async () => {
    const a = await fresh(); mkProj(a,'p1'); const adm = mkUser(a,'adm7','admin'); const u = mkUser(a,'usr7','viewer');
    const t = tok(a,adm).t; const longId = 'a'.repeat(129);
    expect((await mem(a,t,longId)).statusCode).toBe(414);
    expect((await mem(a,t,'%20')).statusCode).toBe(400);
    expect((await grant(a,t,longId,u.id)).statusCode).toBe(414);
    expect((await revoke(a,t,'p1',longId)).statusCode).toBe(414);
    expect((await mem(a,t,'nope')).statusCode).toBe(404);
    expect((await grant(a,t,'nope',u.id)).statusCode).toBe(404);
    expect((await grant(a,t,'p1','ghost')).statusCode).toBe(404);
    expect((await revoke(a,t,'p1','ghost')).statusCode).toBe(404);
    expect((await grant(a,t,'p1%27%20OR%201%3D1--',u.id)).statusCode).toBe(404);
        const p128='p'+'x'.repeat(127); const u128='u'+'y'.repeat(127); mkProj(a,p128); const lu=mkUser(a,u128,'viewer');
    expect(p128.length).toBe(128); expect(u128.length).toBe(128);
    expect(JSON.parse((await grant(a,t,p128,lu.id)).body).changed).toBe(true);
    const lm=await mem(a,t,p128); expect(lm.statusCode).toBe(200); expect(JSON.parse(lm.body).map((m:any)=>[m.userId,m.projectId])).toEqual([[u128,p128]]);
    expect(ids(await list(a,tok(a,lu).t))).toEqual([p128]);
    expect(JSON.parse((await revoke(a,t,p128,lu.id)).body).changed).toBe(true);
    const opaque=' "opaque proj" '; mkProj(a,opaque); const ou=mkUser(a,'usrOpaque','viewer');
    const og=await a.inject({method:'PUT',url:'/api/projects/'+encodeURIComponent(opaque)+'/members/'+ou.id,headers:H(t)}); expect(og.statusCode).toBe(200); expect(JSON.parse(og.body).changed).toBe(true);
    const om=await a.inject({method:'GET',url:'/api/projects/'+encodeURIComponent(opaque)+'/members',headers:H(t)}); expect(om.statusCode).toBe(200); expect(JSON.parse(om.body).map((m:any)=>[m.userId,m.projectId])).toEqual([[ou.id,opaque]]);
    expect(ids(await list(a,tok(a,ou).t))).toEqual([opaque]);
    const od=await a.inject({method:'DELETE',url:'/api/projects/'+encodeURIComponent(opaque)+'/members/'+ou.id,headers:H(t)}); expect(od.statusCode).toBe(200); expect(JSON.parse(od.body).changed).toBe(true);
    expect(cnt(a,projectMemberships)).toBe(0); expect(cnt(a,auditLogs)).toBe(4); expect(cnt(a,projects)).toBe(3);
  });

  it('inactive target grants 404 but revoke succeeds', async () => {
    const a = await fresh(); mkProj(a,'p1'); const adm = mkUser(a,'adm8','admin'); const u = mkUser(a,'usr8','viewer'); const t = tok(a,adm).t;
    expect(JSON.parse((await grant(a,t,'p1',u.id)).body).changed).toBe(true);
    dbOf(a).update(users).set({isActive:false}).where(eq(users.id,u.id)).run();
    expect((await grant(a,t,'p1',u.id)).statusCode).toBe(404);
    const d = await revoke(a,t,'p1',u.id); expect(d.statusCode).toBe(200); expect(JSON.parse(d.body).changed).toBe(true);
  });

  it('revoked, pending and expiry-mismatched sessions are 401', async () => {
    const a = await fresh(); const u = mkUser(a,'usrA','admin'); const k = tok(a,u);
    const s:any = a.sessionRepo.getActiveSession(k.sid, u.id);
    const base = {id:u.id,username:u.username,role:u.role,sid:k.sid,exp:s.expiresAt};
    expect((await a.inject({method:'GET',url:'/api/projects'})).statusCode).toBe(401);
    expect((await list(a,'garbage')).statusCode).toBe(401);
    expect((await list(a, a.jwt.sign(Object.assign({},base,{exp:s.expiresAt+60})))).statusCode).toBe(401);
    expect((await list(a, a.jwt.sign(Object.assign({},base,{is2FaPending:true})))).statusCode).toBe(401);
    a.sessionRepo.revokeSession(k.sid, u.id);
    const r = await list(a, k.t); expect(r.statusCode).toBe(401); expect(JSON.parse(r.body).code).toBe('SESSION_INVALID');
  });

  it('inactive user gets 401 on project list', async () => {
    const a = await fresh(); const u = mkUser(a,'usrB','admin'); const t = tok(a,u).t;
    dbOf(a).update(users).set({isActive:false}).where(eq(users.id,u.id)).run();
    const r = await list(a,t); expect(r.statusCode).toBe(401); expect(JSON.parse(r.body).code).toBe('SESSION_INVALID');
  });

  it('stale admin token after role downgrade is 403 with no writes', async () => {
    const a = await fresh(); const adm = mkUser(a,'admC','admin'); const t = tok(a,adm).t;
    dbOf(a).update(users).set({role:'manager'}).where(eq(users.id,adm.id)).run();
    const p0 = cnt(a,projects); const a0 = cnt(a,auditLogs);
    expect((await post(a,t)).statusCode).toBe(403);
    expect((await mem(a,t,'p1')).statusCode).toBe(403);
    expect((await grant(a,t,'p1','u1')).statusCode).toBe(403);
    expect(cnt(a,projects)).toBe(p0); expect(cnt(a,auditLogs)).toBe(a0);
  });

function raceUser(a:any,role:string){const o=a.userRepo.getAuthStateById.bind(a.userRepo);let d=false;a.userRepo.getAuthStateById=async(id:string)=>{const r=await o(id);if(!d&&r&&r.role==='admin'){d=true;dbOf(a).update(users).set({role}).where(eq(users.id,id)).run();}return r;};}
function raceSession(a:any){const o=a.sessionRepo.getActiveSession.bind(a.sessionRepo);let d=false;a.sessionRepo.getActiveSession=(id:string,uid:string)=>{const r=o(id,uid);if(!d&&r){d=true;dbOf(a).update(authSessions).set({revokedAt:Math.floor(Date.now()/1000)}).where(eq(authSessions.id,id)).run();}return r;};}

  it('race: role downgrade after authenticate is 403 with no writes', async () => {
    const a = await fresh(); mkProj(a,'p1'); const adm = mkUser(a,'admR','admin'); const t = tok(a,adm).t;
    raceUser(a,'viewer');
    const p0=cnt(a,projects), a0=cnt(a,auditLogs), m0=cnt(a,projectMemberships);
    const r = await post(a,t); expect(r.statusCode).toBe(403);
    expect(cnt(a,projects)).toBe(p0); expect(cnt(a,auditLogs)).toBe(a0); expect(cnt(a,projectMemberships)).toBe(m0);
  });

  it('race: session revoked after authenticate is 401 with no writes', async () => {
    const a = await fresh(); mkProj(a,'p1'); const adm = mkUser(a,'admS','admin'); const u = mkUser(a,'tgtS','viewer'); const t = tok(a,adm).t;
    raceSession(a);
    const a0=cnt(a,auditLogs), m0=cnt(a,projectMemberships);
    const r = await grant(a,t,'p1',u.id); expect(r.statusCode).toBe(401); expect(JSON.parse(r.body).code).toBe('SESSION_INVALID');
    expect(cnt(a,projectMemberships)).toBe(m0); expect(cnt(a,auditLogs)).toBe(a0);
  });

  it('client query params cannot broaden project list', async () => {
    const a = await fresh(); mkProj(a,'p1'); mkProj(a,'p2'); const u = mkUser(a,'usrQ','viewer'); addM(a,u.id,'p1');
    const r = await a.inject({method:'GET',url:'/api/projects?userId=admin&role=admin&scope=all',headers:H(tok(a,u).t)});
    expect(r.statusCode).toBe(200); expect(ids(r)).toEqual(['p1']);
  });

  it('create project audit failure rolls back project and retry succeeds', async () => {
    const a = await fresh(); const adm = mkUser(a,'admF1','admin'); const t = tok(a,adm).t;
    const p0=cnt(a,projects), a0=cnt(a,auditLogs);
      trig(a,'fail_proj_audit',`BEFORE INSERT ON audit_logs WHEN NEW.entity='project' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;`);
    const r = await post(a,t,{name:'Rollback'}); expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('RAISE'); expect(r.body).not.toContain('audit_logs'); expect(r.body).not.toContain('INSERT');
    expect(cnt(a,projects)).toBe(p0); expect(cnt(a,auditLogs)).toBe(a0);
    drop(a,'fail_proj_audit');
    const r2 = await post(a,t,{name:'Rollback'}); expect(r2.statusCode).toBe(201);
    expect(cnt(a,projects)).toBe(p0+1); expect(cnt(a,auditLogs)).toBe(a0+1);
  });

  it('grant audit failure rolls back membership and retry succeeds', async () => {
    const a = await fresh(); mkProj(a,'p1'); const adm = mkUser(a,'admF2','admin'); const u = mkUser(a,'usrF2','viewer'); const t = tok(a,adm).t;
    const m0=cnt(a,projectMemberships), a0=cnt(a,auditLogs);
      trig(a,'fail_mem_audit',`BEFORE INSERT ON audit_logs WHEN NEW.entity='project_membership' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;`);
    const r = await grant(a,t,'p1',u.id); expect(r.statusCode).toBe(500);
    expect(cnt(a,projectMemberships)).toBe(m0); expect(cnt(a,auditLogs)).toBe(a0);
    expect(JSON.parse((await list(a, tok(a,u).t)).body)).toEqual([]);
    drop(a,'fail_mem_audit');
    const r2 = await grant(a,t,'p1',u.id); expect(r2.statusCode).toBe(200); expect(JSON.parse(r2.body).changed).toBe(true);
    expect(cnt(a,auditLogs)).toBe(a0+1);
  });

  it('revoke audit failure restores original full membership row and retry succeeds', async () => {
    const a = await fresh(); mkProj(a,'p1'); const adm = mkUser(a,'admF3','admin'); const u = mkUser(a,'usrF3','viewer'); const t = tok(a,adm).t;
    expect(JSON.parse((await grant(a,t,'p1',u.id)).body).changed).toBe(true);
    const before = JSON.stringify(mrows(a)); const a0 = cnt(a,auditLogs);
      trig(a,'fail_rev_audit',`BEFORE INSERT ON audit_logs WHEN NEW.entity='project_membership' AND NEW.action='DELETE' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;`);
    const r = await revoke(a,t,'p1',u.id); expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('RAISE'); expect(r.body).not.toContain('project_membership');
    expect(JSON.stringify(mrows(a))).toBe(before); expect(cnt(a,auditLogs)).toBe(a0);
    expect(ids(await list(a, tok(a,u).t))).toEqual(['p1']);
    drop(a,'fail_rev_audit');
    const r2 = await revoke(a,t,'p1',u.id); expect(r2.statusCode).toBe(200); expect(JSON.parse(r2.body).changed).toBe(true);
    expect(cnt(a,projectMemberships)).toBe(0); expect(cnt(a,auditLogs)).toBe(a0+1);
  });

  it('audit chain remains valid and tuples are unambiguous', async () => {
    const a = await fresh(); mkProj(a,'p1'); mkProj(a,'p2'); const adm = mkUser(a,'admF4','admin'); const u = mkUser(a,'usrF4','viewer'); const t = tok(a,adm).t;
    expect((await grant(a,t,'p1',u.id)).statusCode).toBe(200);
    expect((await grant(a,t,'p2',u.id)).statusCode).toBe(200);
    expect((await revoke(a,t,'p2',u.id)).statusCode).toBe(200);
    const ents = dbOf(a).select().from(auditLogs).all().map((r:any)=>r.entityId).filter(Boolean);
    expect(new Set(ents).size).toBe(2);
    expect(ents.every((e:string)=>e.startsWith('['))).toBe(true);
    expect(a.auditRepo.verifyChainIntegrity(CFG.masterKey).valid).toBe(true);
  });
});

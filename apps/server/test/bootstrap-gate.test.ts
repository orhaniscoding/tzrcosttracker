import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
const BASE={jwtSecret:'test-jwt-secret-very-long-and-secure-1234',masterKey:'test-master-key-32-bytes-long-1234',blindIndexPepper:'test-pepper-for-blind-index-1234'};
const TOKEN='synthetic-bootstrap-token-32chars!';
const WRONG='synthetic-wrong-bootstrap-token-32x';
const PW='Synthetic-Pass-1234';
function payload(u='setup_admin'){return{companyName:'Synthetic Co',baseCurrency:'TRY',admin:{username:u,fullName:'Setup Admin',email:u+'@example.test',password:PW,pin:'1234'},industryTemplate:'blank'};}
async function fresh(t?:string){const a=await buildApp({config:{...BASE,bootstrapToken:t},dbPath:':memory:'});await a.ready();return a;}
function writeSpies(a:FastifyInstance){return[vi.spyOn(a.userRepo,'createUser'),vi.spyOn(a.projectRepo,'createProject'),vi.spyOn(a.categoryRepo,'createCategory'),vi.spyOn(a.whiteLabelRepo,'updateSettings'),vi.spyOn(a.auditRepo,'logAction')];}
async function denied(a:FastifyInstance,opts:any,secret?:string){const s=writeSpies(a);const bs=await a.whiteLabelRepo.getSettings();const before=JSON.stringify({companyName:bs.companyName,baseCurrency:bs.baseCurrency,appTitle:bs.appTitle,updatedAt:bs.updatedAt});const r=await a.inject({method:'POST',url:opts.url||'/api/system/setup',headers:opts.headers,payload:opts.payload});expect(r.statusCode).toBe(403);const b=JSON.parse(r.body);expect(typeof b.error).toBe('string');expect(b.token).toBeUndefined();expect(r.body).not.toContain(TOKEN);if(secret)expect(r.body).not.toContain(secret);for(const x of s)expect(x).not.toHaveBeenCalled();expect(await a.userRepo.listUsers()).toHaveLength(0);expect(await a.projectRepo.listProjects()).toHaveLength(0);expect(await a.categoryRepo.listCategories()).toHaveLength(0);const as=await a.whiteLabelRepo.getSettings();expect(JSON.stringify({companyName:as.companyName,baseCurrency:as.baseCurrency,appTitle:as.appTitle,updatedAt:as.updatedAt})).toBe(before);}
describe('bootstrap gate',()=>{let app:FastifyInstance;afterEach(async()=>{vi.unstubAllEnvs();if(app)await app.close();});
it('loadConfig maps BOOTSTRAP_TOKEN with no default',()=>{vi.stubEnv('JWT_SECRET',BASE.jwtSecret);vi.stubEnv('MASTER_KEY',BASE.masterKey);vi.stubEnv('BLIND_INDEX_PEPPER',BASE.blindIndexPepper);vi.stubEnv('BOOTSTRAP_TOKEN',TOKEN);expect(loadConfig().bootstrapToken).toBe(TOKEN);vi.stubEnv('BOOTSTRAP_TOKEN','');expect(loadConfig().bootstrapToken).toBe('');});
it('rejects when config token missing',async()=>{app=await fresh(undefined);await denied(app,{headers:{'x-setup-token':TOKEN},payload:payload()},TOKEN);});
it('rejects when config token shorter than 32',async()=>{app=await fresh('short-token');await denied(app,{headers:{'x-setup-token':'short-token'},payload:payload()},'short-token');});
it('rejects missing header',async()=>{app=await fresh(TOKEN);await denied(app,{payload:payload()});});
it('rejects wrong header',async()=>{app=await fresh(TOKEN);await denied(app,{headers:{'x-setup-token':WRONG},payload:payload()},WRONG);});
it('rejects array header',async()=>{app=await fresh(TOKEN);await denied(app,{headers:{'x-setup-token':[TOKEN,TOKEN]},payload:payload()});});
it('rejects body-only token',async()=>{app=await fresh(TOKEN);await denied(app,{payload:{...payload(),bootstrapToken:TOKEN,setupToken:TOKEN}});});
it('rejects query-only token',async()=>{app=await fresh(TOKEN);await denied(app,{url:'/api/system/setup?bootstrapToken='+TOKEN,payload:payload()});});
it('correct token creates admin, login works, replay is 403 with no second user',async()=>{app=await fresh(TOKEN);const r=await app.inject({method:'POST',url:'/api/system/setup',headers:{'x-setup-token':TOKEN},payload:payload()});expect(r.statusCode).toBe(201);const b=JSON.parse(r.body);expect(b.user.username).toBe('setup_admin');expect(b.token).toBeDefined();expect(r.body).not.toContain(TOKEN);const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{usernameOrEmail:'setup_admin',password:PW}});expect(login.statusCode).toBe(200);expect(JSON.parse(login.body).token).toBeDefined();const s=writeSpies(app);const replay=await app.inject({method:'POST',url:'/api/system/setup',headers:{'x-setup-token':TOKEN},payload:payload('setup_admin2')});expect(replay.statusCode).toBe(403);for(const x of s)expect(x).not.toHaveBeenCalled();expect(await app.userRepo.listUsers()).toHaveLength(1);});
});

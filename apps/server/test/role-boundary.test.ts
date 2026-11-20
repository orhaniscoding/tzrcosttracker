import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { users } from "@cost-core/database";
import { buildApp } from "../src/app.js";
const SECRET={jwtSecret:"test-jwt-secret-very-long-and-secure-1234",masterKey:"test-master-key-32-bytes-long-1234",blindIndexPepper:"test-pepper-for-blind-index-1234"};
const PASSWORD="Synthetic-Pass-1234";
async function buildFreshApp(){const app=await buildApp({config:SECRET,dbPath:":memory:"});await app.ready();return app;}
function dbOf(app:FastifyInstance):any{return (app.userRepo as any).db;}
async function createSynthetic(app:FastifyInstance,username:string,role:string){return app.userRepo.createUser({username,email:username+"@example.test",fullName:"Synthetic User",password:PASSWORD,role:role as any},app.config.masterKey);}
async function login(app:FastifyInstance,username:string){const res=await app.inject({method:"POST",url:"/api/auth/login",payload:{usernameOrEmail:username,password:PASSWORD}});expect(res.statusCode).toBe(200);return JSON.parse(res.body).token as string;}
function auth(token:string){return {authorization:"Bearer "+token};}
async function auditCount(app:FastifyInstance){return (await app.auditRepo.verifyChainIntegrity(app.config.masterKey)).count;}
async function userCount(app:FastifyInstance){return (await app.userRepo.listUsers()).length;}
async function seedFinancial(app:FastifyInstance,adminToken:string){
 const proj=await app.projectRepo.createProject({name:"Synthetic Project",budget:1000} as any);
 const cat=await app.categoryRepo.createCategory({name:"Synthetic Category"} as any);
 const acc=await app.accountRepo.createAccount({name:"Synthetic Cash",type:"cash",currency:"TRY",initialBalance:10000} as any,app.config.masterKey,app.config.blindIndexPepper);
 const txRes=await app.inject({method:"POST",url:"/api/transactions",headers:auth(adminToken),payload:{type:"expense",date:"2026-10-01T10:00:00.000Z",amount:500,currency:"TRY",categoryId:cat.id,title:"Seed Expense",accountFromId:acc.id,isPaid:true}});
 expect(txRes.statusCode).toBe(201);
 const tx=JSON.parse(txRes.body).transaction;
 return {proj,cat,acc,tx};
}
describe("role boundary",()=>{
 let app:FastifyInstance;
 let tokens:Record<string,string>={};
 let ids:Record<string,string>={};
 beforeEach(async()=>{app=await buildFreshApp();tokens={};ids={};for(const r of ["admin","manager","accountant","viewer","auditor"]){const u=await createSynthetic(app, "rb_"+r, r);ids[r]=u.id;tokens[r]=await login(app,"rb_"+r);}});
 afterEach(async()=>{vi.restoreAllMocks();await app.close();});
 it("only admin creates users; non-admin denied without token/row/audit",async()=>{
  for(const r of ["manager","accountant","viewer","auditor"]){const beforeUsers=await userCount(app);const beforeAudit=await auditCount(app);const res=await app.inject({method:"POST",url:"/api/auth/users",headers:auth(tokens[r]),payload:{username:"evil_"+r,email:"evil_"+r+"@example.test",fullName:"Evil User",password:"Synthetic-Pass-9999",role:"admin"}});expect(res.statusCode).toBe(403);const body=JSON.parse(res.body);expect(body.token).toBeUndefined();expect(body.id).toBeUndefined();expect(await userCount(app)).toBe(beforeUsers);expect(await auditCount(app)).toBe(beforeAudit);expect(await app.userRepo.getUserByUsernameOrEmail("evil_"+r)).toBeNull();}
  const ok=await app.inject({method:"POST",url:"/api/auth/users",headers:auth(tokens.admin),payload:{username:"made_by_admin",email:"made_by_admin@example.test",fullName:"Made Admin",password:"Synthetic-Pass-9999",role:"manager"}});expect(ok.statusCode).toBe(201);expect(JSON.parse(ok.body).username).toBe("made_by_admin");
 });
 it("normal login works for all roles and GET reads allowed",async()=>{
  for(const r of ["admin","manager","accountant","viewer","auditor"]){const res=await app.inject({method:"GET",url:"/api/projects",headers:auth(tokens[r])});expect(res.statusCode).toBe(200);const res2=await app.inject({method:"GET",url:"/api/transactions",headers:auth(tokens[r])});expect(res2.statusCode).toBe(200);}
 });
 it("viewer/auditor mutations denied 403 before changes",async()=>{
  const {proj,cat,acc,tx}=await seedFinancial(app,tokens.admin);
  for(const r of ["viewer","auditor"]){
   const beforeU=await userCount(app);const beforeAudit=await auditCount(app);const beforeTx=(await app.transactionRepo.listTransactions({},app.config.masterKey,app.config.blindIndexPepper)).length;const beforeProj=(await app.projectRepo.listProjects()).length;const beforeAcc=(await app.accountRepo.listAccounts(app.config.masterKey)).length;const beforeBal=(await app.accountRepo.getAccountById(acc.id,app.config.masterKey))?.balance;const beforeTxRow=await app.transactionRepo.getTransactionById(tx.id,app.config.masterKey);
   const attempts=[
    await app.inject({method:"POST",url:"/api/transactions",headers:auth(tokens[r]),payload:{type:"expense",date:"2026-10-02T10:00:00.000Z",amount:999,currency:"TRY",categoryId:cat.id,title:"Blocked Tx",accountFromId:acc.id,isPaid:true}}),
    await app.inject({method:"PUT",url:"/api/transactions/"+tx.id,headers:auth(tokens[r]),payload:{title:"Hacked",amount:1}}),
    await app.inject({method:"DELETE",url:"/api/transactions/"+tx.id,headers:auth(tokens[r])}),
    await app.inject({method:"POST",url:"/api/accounts",headers:auth(tokens[r]),payload:{name:"Blocked Acc",type:"cash",currency:"TRY",initialBalance:1}}),
    await app.inject({method:"POST",url:"/api/projects",headers:auth(tokens[r]),payload:{name:"Blocked Proj"}}),
   ];
   for(const res of attempts){expect(res.statusCode).toBe(403);}
   expect(await userCount(app)).toBe(beforeU);expect(await auditCount(app)).toBe(beforeAudit);expect((await app.transactionRepo.listTransactions({},app.config.masterKey,app.config.blindIndexPepper)).length).toBe(beforeTx);expect((await app.projectRepo.listProjects()).length).toBe(beforeProj);expect((await app.accountRepo.listAccounts(app.config.masterKey)).length).toBe(beforeAcc);expect((await app.accountRepo.getAccountById(acc.id,app.config.masterKey))?.balance).toBe(beforeBal);const afterTx=await app.transactionRepo.getTransactionById(tx.id,app.config.masterKey);expect(afterTx?.title).toBe(beforeTxRow?.title);expect(afterTx?.amount).toBe(beforeTxRow?.amount);
  }
 });
 it("viewer/auditor can use own PIN, 2FA setup, check-duplicate and reads",async()=>{
  const {proj,cat}=await seedFinancial(app,tokens.admin);for(const r of ["viewer","auditor"]){
   const pin=await app.inject({method:"POST",url:"/api/auth/set-pin",headers:auth(tokens[r]),payload:{pin:"4321"}});expect(pin.statusCode).toBe(200);
   const sw=await app.inject({method:"POST",url:"/api/auth/switch-pin",headers:auth(tokens[r]),payload:{pin:"4321"}});expect(sw.statusCode).toBe(200);expect(JSON.parse(sw.body).user.id).toBe(ids[r]);
   const setup=await app.inject({method:"POST",url:"/api/auth/2fa/setup",headers:auth(tokens[r])});expect(setup.statusCode).toBe(200);expect(JSON.parse(setup.body).secret).toBeDefined();
   const dup=await app.inject({method:"POST",url:"/api/transactions/check-duplicate",headers:auth(tokens[r]),payload:{date:"2026-10-01T10:00:00.000Z",title:"Seed Expense",amount:500}});expect(dup.statusCode).toBe(200);
   const gp=await app.inject({method:"GET",url:"/api/projects",headers:auth(tokens[r])});expect(gp.statusCode).toBe(200);const gt=await app.inject({method:"GET",url:"/api/transactions",headers:auth(tokens[r])});expect(gt.statusCode).toBe(200);
  }
 });
 it("unknown DB role gets generic 401",async()=>{
  const u=await createSynthetic(app,"rb_unknown","viewer");const token=await login(app,"rb_unknown");await dbOf(app).update(users).set({role:"banana" as any}).where(eq(users.id,u.id));const res=await app.inject({method:"GET",url:"/api/projects",headers:auth(token)});expect(res.statusCode).toBe(401);expect(JSON.parse(res.body).error).toContain("Yetkisiz");
 });
 it("manager/accountant project creation denied but financial create still works",async()=>{
  const cat=await app.categoryRepo.createCategory({name:"Legit Category"} as any);const wp=await app.inject({method:"POST",url:"/api/projects",headers:auth(tokens.admin),payload:{name:"Legit Wallet Project"}});expect(wp.statusCode).toBe(201);const wpId=JSON.parse(wp.body).id;for(const r of ["manager","accountant"]){const gm=await app.inject({method:"PUT",url:"/api/projects/"+wpId+"/members/"+ids[r],headers:auth(tokens.admin)});expect(gm.statusCode).toBe(200);}
   for(const r of ["manager","accountant"]){const pr=await app.inject({method:"POST",url:"/api/projects",headers:auth(tokens[r]),payload:{name:"Legit Project "+r}});expect(pr.statusCode).toBe(403);const ac=await app.inject({method:"POST",url:"/api/accounts",headers:auth(tokens[r]),payload:{name:"Legit Acc "+r,type:"cash",currency:"TRY",initialBalance:1000,projectId:wpId}});expect(ac.statusCode).toBe(201);const wallet=JSON.parse(ac.body);const tr=await app.inject({method:"POST",url:"/api/transactions",headers:auth(tokens[r]),payload:{type:"expense",date:"2026-10-03T10:00:00.000Z",amount:100,currency:"TRY",categoryId:cat.id,title:"Legit "+r,projectId:wpId,accountFromId:wallet.id,isPaid:true}});expect(tr.statusCode).toBe(201);expect(JSON.parse(tr.body).transaction.projectId).toBe(wpId);expect((await app.accountRepo.getAccountById(wallet.id,app.config.masterKey))?.balance).toBe(900);}
 });
});

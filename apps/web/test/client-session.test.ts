import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, ApiError } from "../src/api/client.js";
const store = new Map<string,string>();
const fakeStorage = { getItem:(k:string)=>store.get(k)??null, setItem:(k:string,v:string)=>{store.set(k,String(v));}, removeItem:(k:string)=>{store.delete(k);} };
(globalThis as any).window = { localStorage: fakeStorage };
function resp(ok:boolean,status:number,body:any){return {ok,status,json:async()=>body};}
function deferred(){let res:any;const p=new Promise((r)=>{res=r;});return {p,resolve:res};}
describe("session invalid handling",()=>{
 beforeEach(()=>{store.clear();ApiClient.setToken(null);});
 afterEach(()=>{ApiClient.setToken(null);vi.unstubAllGlobals();vi.restoreAllMocks();});
 it("current 401 SESSION_INVALID clears token/storage and notifies once",async()=>{
  const listener=vi.fn(); const unsub=ApiClient.subscribeSessionInvalid(listener);
  ApiClient.setToken("tok1"); store.set("costcore_token","tok1");
  vi.stubGlobal("fetch",vi.fn(async()=>resp(false,401,{error:"expired",code:"SESSION_INVALID"})));
  const err:any=await ApiClient.getMe().catch((e:any)=>e);
  expect(err).toBeInstanceOf(ApiError); expect(err.status).toBe(401); expect(err.code).toBe("SESSION_INVALID");
  expect(ApiClient.getToken()).toBeNull(); expect(store.get("costcore_token")).toBeUndefined(); expect(listener).toHaveBeenCalledTimes(1); unsub(); });
 it("repeated invalid response with no token does not notify again",async()=>{
  const listener=vi.fn(); const unsub=ApiClient.subscribeSessionInvalid(listener);
  ApiClient.setToken("tok1"); vi.stubGlobal("fetch",vi.fn(async()=>resp(false,401,{error:"expired",code:"SESSION_INVALID"})));
  await ApiClient.getMe().catch(()=>{}); await ApiClient.getMe().catch(()=>{});
  expect(listener).toHaveBeenCalledTimes(1); unsub(); });
 it("no-token, credential 401, 403, 500 and network failures do not clear valid token",async()=>{
  const listener=vi.fn(); const unsub=ApiClient.subscribeSessionInvalid(listener);
  ApiClient.setToken("valid");
  const seq=[resp(false,401,{error:"no"}),resp(false,401,{error:"bad"}),resp(false,403,{error:"x"}),resp(false,500,{error:"x"})];
  let i=0; vi.stubGlobal("fetch",vi.fn(async()=>seq[i++]));
  for(let k=0;k<4;k++) await ApiClient.getMe().catch(()=>{});
  expect(ApiClient.getToken()).toBe("valid"); expect(listener).not.toHaveBeenCalled();
  vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("net");}));
  await ApiClient.getMe().catch(()=>{}); expect(ApiClient.getToken()).toBe("valid");
  ApiClient.setToken(null); vi.stubGlobal("fetch",vi.fn(async()=>resp(false,401,{error:"x",code:"SESSION_INVALID"})));
  await ApiClient.getMe().catch(()=>{}); expect(listener).not.toHaveBeenCalled(); unsub(); });
 it("deferred old 401 after new login never clears new auth",async()=>{
  const listener=vi.fn(); const unsub=ApiClient.subscribeSessionInvalid(listener);
  ApiClient.setToken("old"); const d=deferred();
  vi.stubGlobal("fetch",vi.fn(()=>d.p));
  const pending=ApiClient.getMe().catch(()=>{}); ApiClient.setToken("new");
  d.resolve(resp(false,401,{error:"expired",code:"SESSION_INVALID"})); await pending;
  expect(ApiClient.getToken()).toBe("new"); expect(listener).not.toHaveBeenCalled();
  ApiClient.setToken(null); unsub(); });
 it("deferred old 401 with same token after re-login generation never clears new auth",async()=>{
  const listener=vi.fn(); const unsub=ApiClient.subscribeSessionInvalid(listener);
  ApiClient.setToken("same"); const d=deferred();
  vi.stubGlobal("fetch",vi.fn(()=>d.p));
  const pending=ApiClient.getMe().catch(()=>{}); ApiClient.setToken("same");
  d.resolve(resp(false,401,{error:"expired",code:"SESSION_INVALID"})); await pending;
  expect(ApiClient.getToken()).toBe("same"); expect(listener).not.toHaveBeenCalled(); unsub(); });
 it("unsubscribe stops notification",async()=>{
  const listener=vi.fn(); const unsub=ApiClient.subscribeSessionInvalid(listener); unsub();
  ApiClient.setToken("tok"); vi.stubGlobal("fetch",vi.fn(async()=>resp(false,401,{error:"x",code:"SESSION_INVALID"})));
  await ApiClient.getMe().catch(()=>{}); expect(listener).not.toHaveBeenCalled(); expect(ApiClient.getToken()).toBeNull(); });
 it("logout POST captures current Authorization even when cleared immediately",async()=>{
  const fetchMock=vi.fn(async()=>resp(true,200,{})); vi.stubGlobal("fetch",fetchMock);
  ApiClient.setToken("currentTok"); const req=ApiClient.logout(); ApiClient.setToken(null); await req;
  expect(fetchMock).toHaveBeenCalledTimes(1); const c=fetchMock.mock.calls[0] as any[];
  expect(c[0]).toBe("/api/auth/logout"); expect(c[1].method).toBe("POST"); expect(c[1].headers.Authorization).toBe("Bearer currentTok"); });
});

describe('request header generation',()=>{
 beforeEach(()=>{store.clear();ApiClient.setToken(null);});
 afterEach(()=>{ApiClient.setToken(null);vi.unstubAllGlobals();vi.restoreAllMocks();});
 it('bodyless POST helpers send no JSON content-type header',async()=>{
  const fetchMock=vi.fn(async()=>resp(true,200,{})); vi.stubGlobal('fetch',fetchMock);
  ApiClient.setToken('tok');
  await ApiClient.markTransactionPaid('t1');
  await ApiClient.setup2FA();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const calls=fetchMock.mock.calls as any;
  for(let i=0;i<calls.length;i++){
   const init=calls[i][1];
   expect(init.method).toBe('POST');
   expect(init.body).toBeUndefined();
   const keys=Object.keys(init.headers as Record<string,string>).map(k=>k.toLowerCase());
   expect(keys).not.toContain('content-type');
   expect((init.headers as Record<string,string>).Authorization).toBe('Bearer tok');
  }
 });
 it('logout sends Authorization without contradictory JSON content-type or body',async()=>{
  const fetchMock=vi.fn(async()=>resp(true,200,{})); vi.stubGlobal('fetch',fetchMock);
  ApiClient.setToken('logoutTok'); const req=ApiClient.logout(); ApiClient.setToken(null); await req;
  const init=(fetchMock.mock.calls[0] as any[])[1];
  expect(init.method).toBe('POST');
  expect(init.body).toBeUndefined();
  const keys=Object.keys(init.headers as Record<string,string>).map(k=>k.toLowerCase());
  expect(keys).not.toContain('content-type');
  expect((init.headers as Record<string,string>).Authorization).toBe('Bearer logoutTok');
 });
 it('JSON login and update send content-type application/json with serialized body',async()=>{
  const fetchMock=vi.fn(async()=>resp(true,200,{})); vi.stubGlobal('fetch',fetchMock);
  ApiClient.setToken('tok');
  await ApiClient.login({username:'u',password:'p'});
  await ApiClient.updateTransaction('t1',{amount:5});
  const loginInit=(fetchMock.mock.calls[0] as any[])[1];
  expect(loginInit.headers['Content-Type']).toBe('application/json');
  expect(loginInit.body).toBe(JSON.stringify({username:'u',password:'p'}));
  const updInit=(fetchMock.mock.calls[1] as any[])[1];
  expect(updInit.method).toBe('PUT');
  expect(updInit.headers['Content-Type']).toBe('application/json');
  expect(updInit.body).toBe(JSON.stringify({amount:5}));
 });
 it('explicit caller headers still override the default JSON content-type',async()=>{
  const fetchMock=vi.fn(async()=>resp(true,200,{})); vi.stubGlobal('fetch',fetchMock);
  await ApiClient.setupSystem({},'setupTok');
  const init=(fetchMock.mock.calls[0] as any[])[1];
  expect(init.headers['Content-Type']).toBe('application/json');
  expect(init.headers['x-setup-token']).toBe('setupTok');
 });
});

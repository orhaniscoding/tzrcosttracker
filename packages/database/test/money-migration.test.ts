import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { encryptField, decryptField } from '@cost-core/crypto';
import { runMigrations, MIGRATIONS } from '../src/migrations.js';
import { decryptMoneyMinor, encryptMoneyMinor } from '../src/money-codec.js';
import { migrateMoneyOffline, MONEY_MIGRATION_V4 } from '../src/money-migration.js';

const key = 'synthetic-key';
const policy = { version: 'test-v1', exponents: { AAA: 2, BBB: 0 } };
const open: InstanceType<typeof Database>[] = [];
type DB = InstanceType<typeof Database>;
function db(): DB {
  const d = new Database(':memory:'); open.push(d);
  d.pragma('foreign_keys = ON'); runMigrations(d); return d;
}
afterEach(() => { while (open.length) open.pop()!.close(); });
function seed(d: DB) {
  d.prepare('INSERT INTO users (id,username,email,full_name,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('u','user','u@example.invalid','user','hash','old','old');
  d.prepare('INSERT INTO categories (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('c','category','old','old');
  const a = d.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,credit_limit_encrypted,iban_encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
  a.run('a','account','idx','AAA',encryptField(-12.34,key),encryptField(0,key),encryptField('iban',key),'old','old');
  a.run('b','account2','idx2','BBB',encryptField(8,key),null,null,'old','old');
  const t = d.prepare('INSERT INTO transactions (id,date,amount_encrypted,currency,base_amount_encrypted,category_id,title_encrypted,title_blind_index,created_by_id,created_at,updated_at,status,deleted_at,oto_kasa_transaction_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  t.run('t1','date',encryptField(2.5,key),'AAA',encryptField(-7,key),'c',encryptField('title',key),'idx','u','old','old','draft','deleted',null);
  t.run('t2','date',encryptField(0,key),'BBB',encryptField(1.23,key),'c',encryptField('title2',key),'idx2','u','old','old','approved',null,'t1');
  d.prepare('UPDATE transactions SET oto_kasa_transaction_id=? WHERE id=?').run('t2','t1');
  expect(d.pragma('foreign_key_check')).toEqual([]);
  return { t1: 'BBB', t2: 'AAA' };
}
function snapshot(d: DB) {
  const exists = (name: string) => !!d.prepare('SELECT 1 FROM main.sqlite_master WHERE type=? AND name=?').get('table',name);
  return JSON.stringify({
    schema: d.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all(),
    users: d.prepare('SELECT * FROM main.users ORDER BY rowid').all(),
    projects: d.prepare('SELECT * FROM main.projects ORDER BY rowid').all(),
    parties: d.prepare('SELECT * FROM main.parties ORDER BY rowid').all(),
    accounts: d.prepare('SELECT * FROM main.accounts ORDER BY rowid').all(),
    categories: d.prepare('SELECT * FROM main.categories ORDER BY rowid').all(),
    customFields: d.prepare('SELECT * FROM main.custom_fields ORDER BY rowid').all(),
    transactions: d.prepare('SELECT * FROM main.transactions ORDER BY rowid').all(),
    audit: d.prepare('SELECT * FROM main.audit_logs ORDER BY rowid').all(),
    settings: d.prepare('SELECT * FROM main.white_label_settings ORDER BY rowid').all(),
    sessions: d.prepare('SELECT * FROM main.auth_sessions ORDER BY rowid').all(),
    memberships: d.prepare('SELECT * FROM main.project_memberships ORDER BY rowid').all(),
    history: d.prepare('SELECT * FROM main.schema_migrations ORDER BY rowid').all(),
    format: exists('money_format') ? d.prepare('SELECT * FROM main.money_format ORDER BY rowid').all() : null,
    provenance: exists('transaction_base_currencies') ? d.prepare('SELECT * FROM main.transaction_base_currencies ORDER BY rowid').all() : null,
  });
}
function unchangedFailure(d: DB, p: Record<string,string>, k: string | Buffer = key, pol = policy) {
  const before = snapshot(d);
  expect(() => migrateMoneyOffline(d,k,pol,p)).toThrow();
  expect(snapshot(d)).toBe(before);
}
function seam(d: DB, callback: (sql: string) => void) {
  const original = d.prepare;
  (d as any).prepare = function(sql: string) {
    const statement = original.call(d, sql);
    return new Proxy(statement, { get(target, prop) {
      if (prop === 'run') return (...args: unknown[]) => { callback(sql); return target.run(...args); };
      const value = (target as any)[prop]; return typeof value === 'function' ? value.bind(target) : value;
    }});
  };
  return () => { (d as any).prepare = original; };
}
describe('offline encrypted money migration', () => {
  it('migrates all fields and verifies without logical changes', () => {
    const d=db(), p=seed(d);
    const oldA=d.prepare('SELECT * FROM accounts ORDER BY id').all() as any[];
    const oldT=d.prepare('SELECT * FROM transactions ORDER BY id').all() as any[];
    expect(migrateMoneyOffline(d,key,policy,p)).toEqual({status:'migrated',accounts:2,transactions:2,encryptedFields:7});
    const a=d.prepare('SELECT * FROM accounts ORDER BY id').all() as any[];
    const t=d.prepare('SELECT * FROM transactions ORDER BY id').all() as any[];
    expect(decryptMoneyMinor(a[0].balance_encrypted,'AAA',policy,key)).toBe(-1234n);
    expect(decryptMoneyMinor(a[0].credit_limit_encrypted,'AAA',policy,key)).toBe(0n);
    expect(decryptMoneyMinor(a[1].balance_encrypted,'BBB',policy,key)).toBe(8n);
    expect(a[1].credit_limit_encrypted).toBeNull();
    expect(decryptMoneyMinor(t[0].amount_encrypted,'AAA',policy,key)).toBe(250n);
    expect(decryptMoneyMinor(t[0].base_amount_encrypted,'BBB',policy,key)).toBe(-7n);
    expect(decryptMoneyMinor(t[1].amount_encrypted,'BBB',policy,key)).toBe(0n);
    expect(decryptMoneyMinor(t[1].base_amount_encrypted,'AAA',policy,key)).toBe(123n);
    for (let i=0;i<2;i++) {
      const {balance_encrypted,credit_limit_encrypted,...rest}=a[i];
      const {balance_encrypted:b,credit_limit_encrypted:c,...before}=oldA[i]; expect(rest).toEqual(before);
      const {amount_encrypted,base_amount_encrypted,...other}=t[i];
      const {amount_encrypted:x,base_amount_encrypted:y,...previous}=oldT[i]; expect(other).toEqual(previous);
    }
    const meta=d.prepare('SELECT * FROM money_format').get() as any;
    const hash=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
    expect(meta.transform_version).toBe('exact-money-v1'); expect(meta.policy_version).toBe(policy.version);
    expect(meta.policy_json).toBe(JSON.stringify(policy)); expect(meta.policy_hash).toBe(hash(meta.policy_json));
    expect(meta.provenance_hash).toBe(hash(JSON.stringify([['t1','BBB'],['t2','AAA']])));
    expect(decryptField(meta.key_check_encrypted,key)).toBe('costcore:exact-money-v1:key-check');
    const history=d.prepare('SELECT * FROM schema_migrations ORDER BY version').all() as any[];
    expect(history.slice(0,3).map(({version,name,checksum})=>({version,name,checksum}))).toEqual(MIGRATIONS);
    expect(history[3]).toMatchObject(MONEY_MIGRATION_V4); expect(history[3].applied_at).toBe(meta.migrated_at);
    const before=snapshot(d);
    expect(migrateMoneyOffline(d,key,{version:'test-v1',exponents:{BBB:0,AAA:2}},{t2:'AAA',t1:'BBB'})).toEqual({status:'verified',accounts:2,transactions:2,encryptedFields:7});
    expect(snapshot(d)).toBe(before); expect(()=>runMigrations(d)).toThrow();
  });
  it('authenticates empty databases',()=>{
    const d=db(); expect(migrateMoneyOffline(d,key,policy,{})).toEqual({status:'migrated',accounts:0,transactions:0,encryptedFields:0});
    const before=snapshot(d); expect(migrateMoneyOffline(d,key,policy,{}).status).toBe('verified');
    expect(()=>migrateMoneyOffline(d,'wrong',policy,{})).toThrow(); expect(snapshot(d)).toBe(before);
  });
  it.each([1,2,4])('rolls back monetary update failure at ordinal %i', target => {
    const d=db(), p=seed(d), before=snapshot(d); let n=0;
    const restore=seam(d,sql=>{ if (/^\s*UPDATE\s+(?:main\.)?(?:accounts|transactions)\b/i.test(sql) && ++n===target) throw new Error('synthetic failure'); });
    try { expect(()=>migrateMoneyOffline(d,key,policy,p)).toThrow(); } finally { restore(); }
    expect(n).toBe(target); expect(snapshot(d)).toBe(before);
  });
  it.each(['money_format','transaction_base_currencies','schema_migrations'])('rolls back insertion failure for %s', table => {
    const d=db(), p=seed(d), before=snapshot(d); let hit=false;
    const restore=seam(d,sql=>{ if (/^\s*INSERT\b/i.test(sql) && sql.toLowerCase().includes(table)) { hit=true; throw new Error('synthetic failure'); } });
    try { expect(()=>migrateMoneyOffline(d,key,policy,p)).toThrow(); } finally { restore(); }
    expect(hit).toBe(true); expect(snapshot(d)).toBe(before);
  });
  it('rolls back persisted corruption before final readback', () => {
    const d=db(), p=seed(d), before=snapshot(d); let n=0, hit=false;
    const restore=seam(d,sql=>{ if (/^\s*UPDATE\s+(?:main\.)?(?:accounts|transactions)\b/i.test(sql) && ++n===4) {
      d.prepare('UPDATE main.accounts SET balance_encrypted=? WHERE id=?').run('corrupt','a'); hit=true;
    }});
    try { expect(()=>migrateMoneyOffline(d,key,policy,p)).toThrow(); } finally { restore(); }
    expect(hit).toBe(true); expect(snapshot(d)).toBe(before);
  });
  it.each([{}, {t1:'BBB'}, {t1:'BBB',t2:'AAA',extra:'AAA'}, {t1:'XXX',t2:'AAA'}])('rejects invalid provenance %#', p=>{const d=db();seed(d);unchangedFailure(d,p);});
  it.each([1.001,0.1+0.2,'1.2',null,{version:1}])('rejects invalid legacy value %#', value=>{
    const d=db(),p=seed(d); d.prepare('UPDATE accounts SET balance_encrypted=? WHERE id=?').run(encryptField(typeof value === 'string' ? JSON.stringify(value) : value === null ? 'null' : value as any,key),'a'); unchangedFailure(d,p);
  });
  it.each(['a','b','t2'])('rejects corrupt legacy ciphertext %s', id=>{
    const d=db(),p=seed(d);
    if(id==='t2') d.prepare('UPDATE transactions SET base_amount_encrypted=? WHERE id=?').run('bad',id);
    else d.prepare('UPDATE accounts SET balance_encrypted=? WHERE id=?').run('bad',id);
    unchangedFailure(d,p);
  });
  it('rejects mixed money and wrong keys',()=>{
    const d=db(),p=seed(d); d.prepare('UPDATE accounts SET balance_encrypted=? WHERE id=?').run(encryptMoneyMinor(1n,'AAA',policy,key),'a');
    unchangedFailure(d,p); unchangedFailure(d,p,'wrong');
  });
  it('rejects accessors without invoking getters',()=>{
    const d=db(); let called=false;
    const p=Object.defineProperty({},'t',{enumerable:true,get(){called=true; throw new Error('getter');}});
    expect(()=>migrateMoneyOffline(d,key,policy,p)).toThrow(); expect(called).toBe(false);
    const bad=Object.defineProperty({},'version',{enumerable:true,get(){called=true; return 'v';}});
    expect(()=>migrateMoneyOffline(d,key,bad as any,{})).toThrow(); expect(called).toBe(false);
  });
  it('snapshots mutable inputs and Buffer key before database work',()=>{
    const d=db(), p=seed(d), buffer=Buffer.from(key), mutable={version:policy.version,exponents:{...policy.exponents}};
    let hit=false; const original=d.prepare;
    (d as any).prepare=function(sql:string){ if(!hit){hit=true; buffer.fill(0); mutable.exponents.AAA=0; p.t1='AAA';} return original.call(d,sql); };
    try { expect(migrateMoneyOffline(d,buffer,mutable,p).status).toBe('migrated'); } finally { (d as any).prepare=original; }
    expect(hit).toBe(true); expect(migrateMoneyOffline(d,key,policy,{t1:'BBB',t2:'AAA'}).status).toBe('verified');
  });
  it('leaves caller transaction open',()=>{
    const d=db(); d.exec('BEGIN'); expect(()=>migrateMoneyOffline(d,key,policy,{})).toThrow();
    expect(d.inTransaction).toBe(true); d.exec('ROLLBACK');
  });
  it('rejects foreign-key, schema and history hazards',()=>{
    for(const setup of [
      (d:DB)=>d.pragma('foreign_keys = OFF'),
      (d:DB)=>d.exec('CREATE TEMP TABLE shadow (id TEXT)'),
      (d:DB)=>d.exec('CREATE TRIGGER bad AFTER UPDATE ON accounts BEGIN SELECT 1; END'),
      (d:DB)=>d.exec('UPDATE schema_migrations SET checksum=char(98,97,100) WHERE version=2'),
      (d:DB)=>d.exec('CREATE TABLE MONEY_FORMAT (id INTEGER)'),
      (d:DB)=>d.exec('CREATE VIEW transaction_base_currencies AS SELECT 1 AS id'),
      (d:DB)=>d.exec('ALTER TABLE accounts ADD COLUMN generated_value TEXT GENERATED ALWAYS AS (balance_encrypted) VIRTUAL'),
    ]) {const d=db(); setup(d); unchangedFailure(d,{});}
  });
  it.each(['canary','policy','provenance','history','ddl','payload','currency'])('rejects verification tampering: %s',kind=>{
    const d=db(),p=seed(d); migrateMoneyOffline(d,key,policy,p);
    if(kind==='canary') d.prepare('UPDATE money_format SET key_check_encrypted=?').run(encryptField('wrong',key));
    if(kind==='policy') d.prepare('UPDATE money_format SET policy_hash=?').run('bad');
    if(kind==='provenance') d.prepare('UPDATE transaction_base_currencies SET currency=? WHERE transaction_id=?').run('AAA','t1');
    if(kind==='history') d.prepare('UPDATE schema_migrations SET checksum=? WHERE version=4').run('bad');
    if(kind==='ddl') {d.exec('ALTER TABLE money_format RENAME TO old_money_format'); d.exec('CREATE TABLE money_format AS SELECT * FROM old_money_format'); d.exec('DROP TABLE old_money_format');}
    if(kind==='payload') d.prepare('UPDATE accounts SET balance_encrypted=? WHERE id=?').run('bad','a');
    if(kind==='currency') d.prepare('UPDATE accounts SET currency=? WHERE id=?').run('BBB','a');
    unchangedFailure(d,p);
  });
  it('rejects altered policy and legacy rows after migration',()=>{
    const d=db(),p=seed(d); migrateMoneyOffline(d,key,policy,p);
    unchangedFailure(d,p,key,{version:'test-v1',exponents:{AAA:0,BBB:0}});
    unchangedFailure(d,p,key,{version:'other',exponents:{AAA:2,BBB:0}});
    d.prepare('UPDATE accounts SET balance_encrypted=? WHERE id=?').run(encryptField(1,key),'a'); unchangedFailure(d,p);
  });
  it('rejects oversized envelopes and excessive provenance',()=>{
    const d=db(),p=seed(d); d.prepare('UPDATE accounts SET balance_encrypted=? WHERE id=?').run('x'.repeat(4097),'a'); unchangedFailure(d,p);
    const e=db(), huge:Record<string,string>={}; for(let i=0;i<100001;i++) huge['id'+i]='AAA'; unchangedFailure(e,huge);
  });
  it.each(['rows','bytes'])('enforces %s cap before financial row materialization',kind=>{
    const sql='INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,credit_limit_encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)';
    const value=kind==='rows' ? encryptField(0,key) : encryptField(' '.repeat(1950)+'0',key);
    expect(decryptField(value,key)).toBe(0);
    if(kind==='bytes') {
      expect(value.length).toBe(3967);
      const control=db(); control.prepare(sql).run('one','n','i','AAA',value,value,'t','t');
      expect(migrateMoneyOffline(control,key,policy,{}).status).toBe('migrated');
    }
    const d=db(), add=d.prepare(sql);
    d.transaction(()=>{ for(let i=0;i<(kind==='rows' ? 100001 : 9000);i++) add.run('id'+i,'n','i','AAA',value,kind==='bytes' ? value : null,'t','t'); })();
    if(kind==='bytes') {
      const totals=d.prepare('SELECT count(*) AS n, sum(length(CAST(balance_encrypted AS BLOB))+length(CAST(credit_limit_encrypted AS BLOB))) AS bytes FROM accounts').get() as any;
      expect(totals).toEqual({n:9000,bytes:71406000}); expect(totals.bytes).toBeGreaterThan(67108864);
    }
    const digest=()=>{ const h=createHash('sha256'); for(const row of d.prepare('SELECT * FROM accounts ORDER BY id').iterate()) h.update(JSON.stringify(row)+'\n'); return h.digest('hex'); };
    const before=digest(), schema=d.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all(), history=d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    let materialized=false, updated=false, failure:any; const original=d.prepare;
    (d as any).prepare=function(sql:string){
      const stmt=original.call(d,sql);
      return new Proxy(stmt,{get(target,prop){
        if(prop==='all') return (...args:unknown[])=>{if(/\bFROM\s+(?:main\.)?(?:accounts|transactions)\b/i.test(sql)) materialized=true; return target.all(...args);};
        if(prop==='run') return (...args:unknown[])=>{if(/^\s*UPDATE\s+(?:main\.)?(?:accounts|transactions)\b/i.test(sql)) updated=true; return target.run(...args);};
        const v=(target as any)[prop]; return typeof v==='function' ? v.bind(target) : v;
      }});
    };
    try { migrateMoneyOffline(d,key,policy,{}); } catch(e) { failure=e; } finally { (d as any).prepare=original; }
    expect(failure).toBeInstanceOf(Error); expect(materialized).toBe(false); expect(updated).toBe(false); expect(d.inTransaction).toBe(false);
    expect(digest()).toBe(before); expect(d.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all()).toEqual(schema);
    expect(d.prepare('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(history);
  },60000);
});

describe('frozen migration boundaries', () => {
  it('stores the exact canonical DDL and fixed checksum', () => {
    const d=db();
    expect(Object.isFrozen(MONEY_MIGRATION_V4)).toBe(true);
    expect(MONEY_MIGRATION_V4).toEqual({version:4,name:'exact-money-v1',checksum:'a498256d561feb4b783ae72d3247120ec41ebcf5057d29b864e86af8a7d90160'});
    migrateMoneyOffline(d,key,policy,{});
    const rows=d.prepare('SELECT name,sql FROM main.sqlite_master WHERE name IN (?,?) ORDER BY name').all('money_format','transaction_base_currencies');
    expect(rows).toEqual([
      {name:'money_format',sql:'CREATE TABLE money_format (id INTEGER PRIMARY KEY CHECK (id = 1), format_version INTEGER NOT NULL CHECK (format_version = 1), transform_version TEXT NOT NULL, policy_version TEXT NOT NULL, policy_json TEXT NOT NULL, policy_hash TEXT NOT NULL, provenance_hash TEXT NOT NULL, key_check_encrypted TEXT NOT NULL, migrated_at TEXT NOT NULL)'},
      {name:'transaction_base_currencies',sql:'CREATE TABLE transaction_base_currencies (transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id) ON DELETE CASCADE, currency TEXT NOT NULL)'}
    ]);
  });
  it.each([
    (d:DB)=>d.exec('DELETE FROM schema_migrations WHERE version=2'),
    (d:DB)=>d.exec('UPDATE schema_migrations SET applied_at=char() WHERE version=1'),
    (d:DB)=>d.exec('ALTER TABLE transactions ADD COLUMN hidden_money TEXT GENERATED ALWAYS AS (amount_encrypted) VIRTUAL'),
    (d:DB)=>d.exec('CREATE TEMP VIEW shadow_view AS SELECT 1'),
    (d:DB)=>d.exec('CREATE TABLE TRANSACTION_BASE_CURRENCIES (id TEXT)')
  ])('rejects malformed history or hidden/shadow schema without changes %#', setup => {
    const d=db(); setup(d); unchangedFailure(d,{});
  });
});

describe('additional frozen boundaries', () => {
  it('uses UTF-16 ordering and UTF-8 hashing for provenance', () => {
    const d=db(); seed(d); d.exec('UPDATE transactions SET oto_kasa_transaction_id=NULL');
    const ids=['!',String.fromCodePoint(233),String.fromCodePoint(0x10000),String.fromCodePoint(0xe000)];
    const rename=d.prepare('UPDATE transactions SET id=? WHERE id=?'); rename.run(ids[0],'t1'); rename.run(ids[1],'t2');
    const clone=d.prepare('INSERT INTO transactions (id,date,amount_encrypted,currency,base_amount_encrypted,category_id,title_encrypted,title_blind_index,created_by_id,created_at,updated_at,status) SELECT ?,date,amount_encrypted,currency,base_amount_encrypted,category_id,title_encrypted,title_blind_index,created_by_id,created_at,updated_at,status FROM transactions WHERE id=?');
    clone.run(ids[2],ids[0]); clone.run(ids[3],ids[1]);
    const p:Record<string,string>={}; p[ids[3]]='AAA'; p[ids[2]]='BBB'; p[ids[1]]='AAA'; p[ids[0]]='AAA';
    expect(migrateMoneyOffline(d,key,policy,p).status).toBe('migrated');
    expect((d.prepare('SELECT provenance_hash FROM money_format').get() as any).provenance_hash).toBe('499ed971ca7a0e828d407d5ffc588016346335f2982398cd2ed2589f0b15fb7b');
    const before=snapshot(d); expect(migrateMoneyOffline(d,key,policy,p).status).toBe('verified'); expect(snapshot(d)).toBe(before);
  });
  it('preserves nonempty audit and historical rows', () => {
    const d=db(),p=seed(d); d.prepare('INSERT INTO audit_logs (id,user_id,action,entity,entity_id,timestamp,diff_encrypted,hash,previous_hash) VALUES (?,?,?,?,?,?,?,?,?)').run('audit','u','update','account','a','old',encryptField({x:1},key),'hash','previous');
    d.prepare('UPDATE accounts SET balance_encrypted=? WHERE id=?').run(encryptField(1.2,key),'a');
    const audit=d.prepare('SELECT * FROM audit_logs').all(), history=d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    migrateMoneyOffline(d,key,policy,p); expect(d.prepare('SELECT * FROM audit_logs').all()).toEqual(audit); expect(d.prepare('SELECT * FROM schema_migrations WHERE version<=3 ORDER BY version').all()).toEqual(history);
    expect(decryptMoneyMinor((d.prepare('SELECT balance_encrypted FROM accounts WHERE id=?').get('a') as any).balance_encrypted,'AAA',policy,key)).toBe(120n);
  });
  it('rejects missing singleton metadata without repair', () => { const d=db(); migrateMoneyOffline(d,key,policy,{}); d.exec('DELETE FROM money_format'); unchangedFailure(d,{}); });
});

describe('SQL observation and error boundaries', () => {
  it('performs no mutating SQL while verifying', () => {
    const d=db(),p=seed(d); migrateMoneyOffline(d,key,policy,p); const before=snapshot(d); const seen:string[]=[];
    const prepare=d.prepare, exec=d.exec;
    (d as any).prepare=function(sql:string){seen.push(sql); return prepare.call(d,sql);};
    (d as any).exec=function(sql:string){seen.push(sql); return exec.call(d,sql);};
    try { expect(migrateMoneyOffline(d,key,policy,p).status).toBe('verified'); } finally { (d as any).prepare=prepare; (d as any).exec=exec; }
    expect(seen.join('; ')).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i); expect(snapshot(d)).toBe(before);
  });
  it.each(['prepare','run'])('sanitizes %s faults and preserves safe SQLITE_BUSY code', phase => {
    const d=db(),p=seed(d),before=snapshot(d), original=d.prepare; let hit=false;
    (d as any).prepare=function(sql:string){
      if (!hit && phase==='prepare') { hit=true; const e=Object.assign(new Error('sensitive-row-ciphertext-key'),{code:'SQLITE_BUSY'}); throw e; }
      const stmt=original.call(d,sql);
      return new Proxy(stmt,{get(target,prop){
        if(prop==='run') return (...args:unknown[])=>{if(!hit && phase==='run'){hit=true; throw Object.assign(new Error('sensitive-row-ciphertext-key'),{code:'SQLITE_BUSY'});} return target.run(...args);};
        const value=(target as any)[prop]; return typeof value==='function' ? value.bind(target) : value;
      }});
    };
    let error:any; try { migrateMoneyOffline(d,key,policy,p); } catch(e) { error=e; } finally { (d as any).prepare=original; }
    expect(hit).toBe(true); expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain('sensitive'); expect(error.cause).toBeUndefined(); expect(error.code).toBe('SQLITE_BUSY'); expect(snapshot(d)).toBe(before);
  });
});

describe('post-write persistence guards', () => {
  it('rejects a wrong key against valid nonempty legacy data', () => {
    const d=db(), p=seed(d); unchangedFailure(d,p,'wrong-key');
  });
  it.each(['policy_hash','key_check_encrypted','provenance','history'])('rolls back persisted %s corruption after migration writes', kind => {
    const d=db(), p=seed(d), before=snapshot(d), original=d.prepare, originalExec=d.exec;
    let armed=false, changes=0, observed:unknown, expected:unknown, rollback=false, failure:unknown;
    (d as any).exec=function(sql:string) { if(/^\s*ROLLBACK\b/i.test(sql)) rollback=true; return originalExec.call(d,sql); };
    (d as any).prepare=function(sql:string) {
      if(armed && /^\s*SELECT\s+id,currency,balance_encrypted,credit_limit_encrypted\s+FROM\s+main\.accounts/i.test(sql)) {
        armed=false;
        const target = kind==='provenance' ? ['UPDATE main.transaction_base_currencies SET currency=? WHERE transaction_id=?','SELECT currency AS value FROM main.transaction_base_currencies WHERE transaction_id=?','AAA','t1'] :
          kind==='history' ? ['UPDATE main.schema_migrations SET checksum=? WHERE version=4','SELECT checksum AS value FROM main.schema_migrations WHERE version=4','bad'] :
          kind==='policy_hash' ? ['UPDATE main.money_format SET policy_hash=?','SELECT policy_hash AS value FROM main.money_format','bad'] :
          ['UPDATE main.money_format SET key_check_encrypted=?','SELECT key_check_encrypted AS value FROM main.money_format',encryptField('wrong',key)];
        expected=target[2];
        changes=original.call(d,target[0]).run(...target.slice(2)).changes;
        observed=(original.call(d,target[1]).get(...(kind==='provenance' ? ['t1'] : [])) as any)?.value;
      }
      const statement=original.call(d,sql);
      return new Proxy(statement,{get(target,prop) {
        if(prop==='run') return (...args:unknown[]) => {
          const result=target.run(...args);
          if(/^\s*INSERT\s+INTO\s+(?:main\.)?schema_migrations\b/i.test(sql) && args[0]===4 && result.changes===1) armed=true;
          return result;
        };
        const value=(target as any)[prop]; return typeof value==='function' ? value.bind(target) : value;
      }});
    };
    try { migrateMoneyOffline(d,key,policy,p); } catch(e) { failure=e; } finally { (d as any).prepare=original; (d as any).exec=originalExec; }
    expect(changes).toBe(1); expect(observed).toBe(expected); expect(expected).toBeDefined();
    expect(failure).toBeInstanceOf(Error); expect(rollback).toBe(true); expect(d.inTransaction).toBe(false); expect(snapshot(d)).toBe(before);
  });
});

describe('input snapshot boundaries', () => {
  it.each(['', Buffer.alloc(0), null, 42])('rejects invalid key %#', k => {
    const d=db(); expect(() => migrateMoneyOffline(d,k as any,policy,{})).toThrow();
  });
  it('rejects nested accessors and symbols without invoking getters', () => {
    const d=db(); let called=false;
    const ex=Object.defineProperty({},'AAA',{enumerable:true,get(){called=true; return 2;}});
    expect(() => migrateMoneyOffline(d,key,{version:'test-v1',exponents:ex},{})).toThrow();
    expect(called).toBe(false);
    const symbols={AAA:2,[Symbol('hidden')]:0};
    expect(() => migrateMoneyOffline(d,key,{version:'test-v1',exponents:symbols},{})).toThrow();
    expect(() => migrateMoneyOffline(d,key,policy,Object.assign(Object.create({inherited:'AAA'}),{}))).toThrow();
  });
  it('accepts null-prototype snapshots', () => {
    const d=db(); const ex=Object.assign(Object.create(null),policy.exponents);
    const p=Object.assign(Object.create(null),{version:policy.version,exponents:ex});
    expect(migrateMoneyOffline(d,key,p,Object.create(null)).status).toBe('migrated');
    expect(migrateMoneyOffline(d,key,p,Object.create(null)).status).toBe('verified');
  });
  it.each([' '.repeat(1),'x'.repeat(129),'\ud800'])('rejects invalid provenance ID %#', id => {
    const d=db(), p:Record<string,string>=Object.create(null); p[id]='AAA'; unchangedFailure(d,p);
  });
});

describe('additional write and envelope boundaries', () => {
  it('rejects a genuinely authenticated oversized envelope', () => {
    const d=db(), p=seed(d), cipher=encryptField(' '.repeat(2100)+'0',key);
    expect(decryptField(cipher,key)).toBe(0); expect(cipher.length).toBe(4267);
    expect(d.prepare('UPDATE main.accounts SET balance_encrypted=? WHERE id=?').run(cipher,'a').changes).toBe(1);
    expect((d.prepare('SELECT balance_encrypted FROM main.accounts WHERE id=?').get('a') as any).balance_encrypted).toBe(cipher);
    const before=snapshot(d); let failure:any;
    try { migrateMoneyOffline(d,key,policy,p); } catch(e) { failure=e; }
    expect(failure).toBeInstanceOf(Error); expect(failure.message).toBe('Money migration failed'); expect(failure.cause).toBeUndefined();
    expect(d.inTransaction).toBe(false); expect(snapshot(d)).toBe(before);
  });
  it('rolls back if a monetary update reports zero changes', () => {
    const d=db(), p=seed(d), before=snapshot(d), original=d.prepare; let hit=false;
    (d as any).prepare=function(sql:string) {
      const stmt=original.call(d,sql);
      return new Proxy(stmt,{get(target,prop) {
        if(prop==='run') return (...args:unknown[]) => {
          if(!hit && /^\s*UPDATE\s+(?:main\.)?accounts\b/i.test(sql)) { hit=true; return {changes:0,lastInsertRowid:0}; }
          return target.run(...args);
        };
        const value=(target as any)[prop]; return typeof value==='function' ? value.bind(target) : value;
      }});
    };
    try { expect(()=>migrateMoneyOffline(d,key,policy,p)).toThrow(); } finally { (d as any).prepare=original; }
    expect(hit).toBe(true); expect(snapshot(d)).toBe(before);
  });
});

describe('combined row limit', () => {
  it('counts accounts and transactions together before materializing either', () => {
    const d=db(); seed(d);
    const account=d.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
    const transaction=d.prepare('INSERT INTO transactions (id,date,amount_encrypted,currency,base_amount_encrypted,category_id,title_encrypted,title_blind_index,created_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const numeric=encryptField(0,key), provenance:Record<string,string>={t1:'BBB',t2:'AAA'};
    expect(decryptField(numeric,key)).toBe(0);
    d.transaction(() => {
      for(let i=0;i<49999;i++) account.run('limit-a'+i,'n','i','AAA',numeric,'t','t');
      for(let i=0;i<49998;i++) { const id='limit-t'+i; transaction.run(id,'t',numeric,'AAA',numeric,'c','x','i','u','t','t'); provenance[id]='AAA'; }
    })();
    const original=d.prepare; let materialized=false;
    (d as any).prepare=function(sql:string) {
      const stmt=original.call(d,sql);
      return new Proxy(stmt,{get(target,prop) {
        if(prop==='all') return (...args:unknown[]) => { if(/\bFROM\s+(?:main\.)?(?:accounts|transactions)\b/i.test(sql)) materialized=true; return target.all(...args); };
        const value=(target as any)[prop]; return typeof value==='function' ? value.bind(target) : value;
      }});
    };
    try { expect(() => migrateMoneyOffline(d,key,policy,provenance)).toThrow(); } finally { (d as any).prepare=original; }
    expect(materialized).toBe(false);
    expect((d.prepare('SELECT count(*) AS n FROM main.accounts').get() as any).n).toBe(50001);
    expect((d.prepare('SELECT count(*) AS n FROM main.transactions').get() as any).n).toBe(50000);
    expect(d.inTransaction).toBe(false);
  });
});

describe('static error redaction', () => {
  it('does not expose distinct database fault messages or causes', () => {
    const errors: Error[] = [];
    for (const secret of ['private-ciphertext-one','private-key-two']) {
      const d=db(), original=d.prepare;
      (d as any).prepare=function() { throw new Error(secret, {cause: new Error(secret)}); };
      try { migrateMoneyOffline(d,key,policy,{}); } catch (error) { errors.push(error as Error); } finally { (d as any).prepare=original; }
    }
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toBe(errors[1].message);
    for (const error of errors) {
      expect(error.message).not.toMatch(/private/);
      expect(error.cause).toBeUndefined();
    }
  });
});

describe('additional input and error regressions', () => {
  it('copies a 32-byte caller key before database work', () => {
    const d=db(), originalKey=Buffer.alloc(32, 7), callerKey=Buffer.from(originalKey);
    const cipher=encryptField(12.34,originalKey);
    d.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('a','n','i','AAA',cipher,'t','t');
    const original=d.prepare; let hit=false;
    (d as any).prepare=function(sql:string) { if(!hit) { hit=true; callerKey.fill(0); } return original.call(d,sql); };
    try { expect(migrateMoneyOffline(d,callerKey,policy,{}).status).toBe('migrated'); } finally { (d as any).prepare=original; }
    expect(hit).toBe(true);
    expect(migrateMoneyOffline(d,originalKey,policy,{}).status).toBe('verified');
  });
  it('rejects invalid policies even on an empty database', () => {
    const d=db(), before=snapshot(d); let called=false;
    const getter=Object.defineProperty({},'AAA',{enumerable:true,get(){called=true; throw new Error('private');}});
    const many:Record<string,number>={}; for(let i=0;i<65;i++) many[String.fromCharCode(65+Math.floor(i/26),65+i%26,65)]=2;
    const cases:any[]=[
      {version:'',exponents:{AAA:2}}, {version:'v'.repeat(65),exponents:{AAA:2}}, {version:'v\n',exponents:{AAA:2}},
      {version:'v',exponents:{aaA:2}}, {version:'v',exponents:{'AAA\n':2}}, {version:'v',exponents:many},
      {version:'v',exponents:{AAA:'2'}}, {version:'v',exponents:{AAA:-1}}, {version:'v',exponents:{AAA:19}},
      {version:'v',exponents:getter}, {version:'v',exponents:{AAA:2,[Symbol('hidden')]:1}},
      Object.assign(Object.create({extra:true}),{version:'v',exponents:{AAA:2}})
    ];
    for(const invalid of cases) { expect(()=>migrateMoneyOffline(d,key,invalid,{})).toThrow(); expect(snapshot(d)).toBe(before); }
    expect(called).toBe(false);
  });
  it.each(['own-getter','inherited-getter','descriptor-trap','busy'])('sanitizes hostile error code: %s', kind => {
    const d=db(), before=snapshot(d), original=d.prepare; let getterCalled=false, hit=false;
    let fault:any=new Error('private fault', {cause:new Error('private cause')});
    if(kind==='own-getter') Object.defineProperty(fault,'code',{get(){getterCalled=true; throw new Error('private getter');}});
    if(kind==='inherited-getter') { const proto=Object.create(Error.prototype,{code:{get(){getterCalled=true; throw new Error('private getter');}}}); Object.setPrototypeOf(fault,proto); }
    if(kind==='descriptor-trap') fault=new Proxy(fault,{getOwnPropertyDescriptor(){throw new Error('private trap');}});
    if(kind==='busy') Object.defineProperty(fault,'code',{value:'SQLITE_BUSY'});
    (d as any).prepare=function() { hit=true; throw fault; };
    let error:any; try { migrateMoneyOffline(d,key,policy,{}); } catch(e) { error=e; } finally { (d as any).prepare=original; }
    expect(hit).toBe(true); expect(getterCalled).toBe(false); expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Money migration failed'); expect(error.cause).toBeUndefined();
    expect(error.code).toBe(kind==='busy' ? 'SQLITE_BUSY' : undefined); expect(d.inTransaction).toBe(false); expect(snapshot(d)).toBe(before);
  });
});

describe('authenticated malformed MoneyV1 payloads', () => {
  it.each([
    ['shape', {version:1,policyVersion:'test-v1',currency:'AAA',exponent:2}],
    ['version', {version:2,policyVersion:'test-v1',currency:'AAA',exponent:2,minor:'123'}],
    ['policy version', {version:1,policyVersion:'other',currency:'AAA',exponent:2,minor:'123'}],
    ['exponent', {version:1,policyVersion:'test-v1',currency:'AAA',exponent:0,minor:'123'}],
    ['currency', {version:1,policyVersion:'test-v1',currency:'BBB',exponent:2,minor:'123'}],
    ['minor', {version:1,policyVersion:'test-v1',currency:'AAA',exponent:2,minor:'01'}],
  ])('rejects authenticated invalid %s on verification', (_label,payload) => {
    const d=db(), p=seed(d);
    expect(migrateMoneyOffline(d,key,policy,p).status).toBe('migrated');
    const encrypted=encryptField(payload,key);
    expect(decryptField(encrypted,key)).toEqual(payload);
    expect(d.prepare('UPDATE main.accounts SET balance_encrypted=? WHERE id=?').run(encrypted,'a').changes).toBe(1);
    const before=snapshot(d);
    expect(()=>migrateMoneyOffline(d,key,policy,p)).toThrow('Money migration failed');
    expect(d.inTransaction).toBe(false); expect(snapshot(d)).toBe(before);
  });
});

describe('transaction fault semantics', () => {
  it.each(['commit-before','commit-after','rollback-after','rollback-before'])('redacts %s and accurately reports persistence', kind => {
    const d=db(), p=seed(d), before=snapshot(d), originalExec=d.exec, originalPrepare=d.prepare;
    let commitHit=false, rollbackHit=false, injected=false, updateChanges=0, error:any;
    (d as any).exec=function(sql:string) {
      if(/^\s*COMMIT\b/i.test(sql) && kind.startsWith('commit')) {
        commitHit=true;
        if(kind==='commit-after') originalExec.call(d,sql);
        throw new Error('private commit fault', {cause:new Error('private cause')});
      }
      if(/^\s*ROLLBACK\b/i.test(sql)) {
        rollbackHit=true;
        if(kind==='rollback-before') throw new Error('private rollback fault');
        const result=originalExec.call(d,sql);
        if(kind==='rollback-after') throw new Error('private rollback fault');
        return result;
      }
      return originalExec.call(d,sql);
    };
    (d as any).prepare=function(sql:string) {
      const stmt=originalPrepare.call(d,sql);
      return new Proxy(stmt,{get(target,prop) {
        if(prop==='run') return (...args:unknown[]) => {
          const result=target.run(...args);
          if(kind.startsWith('rollback') && !injected && /^\s*UPDATE\s+main\.accounts\b/i.test(sql)) {
            injected=true; updateChanges=result.changes; throw new Error('private write fault');
          }
          return result;
        };
        const value=(target as any)[prop]; return typeof value==='function' ? value.bind(target) : value;
      }});
    };
    try { migrateMoneyOffline(d,key,policy,p); } catch(e) { error=e; } finally { (d as any).exec=originalExec; (d as any).prepare=originalPrepare; }
    expect(error).toBeInstanceOf(Error); expect(error.message).toBe('Money migration failed'); expect(error.cause).toBeUndefined();
    expect(rollbackHit).toBe(true);
    if(kind.startsWith('commit')) expect(commitHit).toBe(true); else { expect(injected).toBe(true); expect(updateChanges).toBe(1); }
    if(kind==='commit-after') {
      expect(d.inTransaction).toBe(false); expect(snapshot(d)).not.toBe(before);
      expect(migrateMoneyOffline(d,key,policy,p).status).toBe('verified');
    } else if(kind==='rollback-before') {
      expect(d.inTransaction).toBe(true); expect(snapshot(d)).not.toBe(before);
      originalExec.call(d,'ROLLBACK');
      expect(d.inTransaction).toBe(false); expect(snapshot(d)).toBe(before);
    } else {
      expect(d.inTransaction).toBe(false); expect(snapshot(d)).toBe(before);
    }
  });
});

describe('matching provenance ID boundaries', () => {
  it.each([['valid 128', 'x'.repeat(128), true], ['whitespace', '   ', false], ['overlength', 'x'.repeat(129), false]])('%s with matching stored transaction', (_label,id,valid) => {
    const d=db(); seed(d); d.exec('UPDATE transactions SET oto_kasa_transaction_id=NULL');
    expect(d.prepare('UPDATE transactions SET id=? WHERE id=?').run(id,'t1').changes).toBe(1);
    expect((d.prepare('SELECT id FROM transactions WHERE id=?').get(id) as any).id).toBe(id);
    const p:Record<string,string>=Object.create(null); p[id]='BBB'; p.t2='AAA';
    if(valid) {
      expect(migrateMoneyOffline(d,key,policy,p).status).toBe('migrated');
      expect(migrateMoneyOffline(d,key,policy,p).status).toBe('verified');
    } else unchangedFailure(d,p);
  });
  it('rejects an unpaired surrogate before accessing SQLite', () => {
    const d=db(), id='\ud800', p:Record<string,string>=Object.create(null); p[id]='AAA';
    expect(Buffer.from(id,'utf8').toString('utf8')).not.toBe(id);
    const original=d.prepare, originalExec=d.exec; let accessed=false;
    (d as any).prepare=function(sql:string){ accessed=true; return original.call(d,sql); };
    (d as any).exec=function(sql:string){ accessed=true; return originalExec.call(d,sql); };
    try { expect(()=>migrateMoneyOffline(d,key,policy,p)).toThrow('Money migration failed'); }
    finally { (d as any).prepare=original; (d as any).exec=originalExec; }
    expect(accessed).toBe(false); expect(d.inTransaction).toBe(false);
  });
});

describe('generated ciphertext aggregate cap', () => {
  it('rolls back real writes when otherwise valid generated ciphertext exceeds 64 MiB', () => {
    const pol={version:'v'.repeat(64),exponents:{AAA:18}};
    const legacy=encryptField(-1e81,key);
    expect(decryptField(legacy,key)).toBe(-1e81);
    expect(legacy.length).toBe(77);
    const addSql='INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,credit_limit_encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)';
    const small=db(); small.prepare(addSql).run('one','n','i','AAA',legacy,legacy,'t','t');
    expect(migrateMoneyOffline(small,key,pol,{}).status).toBe('migrated');
    const generated=(small.prepare('SELECT balance_encrypted FROM accounts WHERE id=?').get('one') as any).balance_encrypted;
    expect(generated.length).toBe(543);
    expect(decryptMoneyMinor(generated,'AAA',pol,key)).toBe(-(10n ** 99n));
    const d=db(), add=d.prepare(addSql);
    d.transaction(()=>{ for(let i=0;i<62000;i++) add.run('a'+i,'n','i','AAA',legacy,legacy,'t','t'); })();
    const totals=d.prepare('SELECT count(*) AS n,sum(length(balance_encrypted)+length(credit_limit_encrypted)) AS bytes FROM accounts').get() as any;
    expect(totals).toEqual({n:62000,bytes:9548000});
    expect(62000*2*generated.length).toBeGreaterThan(67108864);
    const digest=()=>{ const h=createHash('sha256'); for(const row of d.prepare('SELECT * FROM accounts ORDER BY id').iterate()) h.update(JSON.stringify(row)+'\n'); return h.digest('hex'); };
    const before=digest(), schema=d.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all(), history=d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    const prepare=d.prepare, exec=d.exec; let writes=0, rollback=false, failure:any;
    (d as any).exec=function(sql:string){ if(/^\s*ROLLBACK\b/i.test(sql)) rollback=true; return exec.call(d,sql); };
    (d as any).prepare=function(sql:string){ const stmt=prepare.call(d,sql); return new Proxy(stmt,{get(target,prop){
      if(prop==='run') return (...args:unknown[])=>{const result=target.run(...args); if(/^\s*UPDATE\s+main\.accounts\b/i.test(sql)) writes+=result.changes; return result;};
      const value=(target as any)[prop]; return typeof value==='function' ? value.bind(target) : value;
    }}); };
    try { migrateMoneyOffline(d,key,pol,{}); } catch(e) { failure=e; } finally { (d as any).prepare=prepare; (d as any).exec=exec; }
    expect(writes).toBeGreaterThan(60000); expect(rollback).toBe(true); expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Money migration failed'); expect(failure.cause).toBeUndefined(); expect(d.inTransaction).toBe(false);
    expect(digest()).toBe(before); expect(d.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all()).toEqual(schema);
    expect(d.prepare('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(history);
  },60000);
});

describe('v4 timestamp canonical verification', () => {
  it.each(['not-a-date','2026-11-14','2026-11-14T00:00:00.000+00:00','2026-11-14T00:00:00Z','2026-02-30T00:00:00.000Z',' 2026-11-14T00:00:00.000Z ','','   '])('rejects paired noncanonical timestamp %j', invalid => {
    const d=db();
    expect(migrateMoneyOffline(d,key,policy,{}).status).toBe('migrated');
    expect(migrateMoneyOffline(d,key,policy,{}).status).toBe('verified');
    const history=d.prepare('SELECT applied_at FROM schema_migrations WHERE version=4').get() as any;
    const format=d.prepare('SELECT migrated_at FROM money_format WHERE id=1').get() as any;
    expect(history.applied_at).toBe(format.migrated_at);
    expect(new Date(history.applied_at).toISOString()).toBe(history.applied_at);
    expect(d.prepare('UPDATE schema_migrations SET applied_at=? WHERE version=4').run(invalid).changes).toBe(1);
    expect(d.prepare('UPDATE money_format SET migrated_at=? WHERE id=1').run(invalid).changes).toBe(1);
    expect((d.prepare('SELECT applied_at FROM schema_migrations WHERE version=4').get() as any).applied_at).toBe(invalid);
    expect((d.prepare('SELECT migrated_at FROM money_format WHERE id=1').get() as any).migrated_at).toBe(invalid);
    const before=snapshot(d); let error:any;
    try { migrateMoneyOffline(d,key,policy,{}); } catch(e) { error=e; }
    expect(error).toBeInstanceOf(Error); expect(error.message).toBe('Money migration failed'); expect(error.cause).toBeUndefined();
    expect(d.inTransaction).toBe(false); expect(snapshot(d)).toBe(before);
  });
  it('rejects a single-field timestamp mismatch without changes', () => {
    const d=db(); expect(migrateMoneyOffline(d,key,policy,{}).status).toBe('migrated');
    expect(d.prepare('UPDATE money_format SET migrated_at=? WHERE id=1').run('2000-01-01T00:00:00.000Z').changes).toBe(1);
    const before=snapshot(d); let error:any;
    try { migrateMoneyOffline(d,key,policy,{}); } catch(e) { error=e; }
    expect(error).toBeInstanceOf(Error); expect(error.message).toBe('Money migration failed'); expect(error.cause).toBeUndefined();
    expect(d.inTransaction).toBe(false); expect(snapshot(d)).toBe(before);
  });
  it('preserves and accepts nonempty legacy history timestamps', () => {
    const d=db();
    expect(d.prepare('UPDATE schema_migrations SET applied_at=? WHERE version<=3').run('legacy timestamp text').changes).toBe(3);
    const before=d.prepare('SELECT version,applied_at FROM schema_migrations WHERE version<=3 ORDER BY version').all();
    expect(migrateMoneyOffline(d,key,policy,{}).status).toBe('migrated');
    expect(d.prepare('SELECT version,applied_at FROM schema_migrations WHERE version<=3 ORDER BY version').all()).toEqual(before);
    expect(migrateMoneyOffline(d,key,policy,{}).status).toBe('verified');
    expect(d.prepare('SELECT version,applied_at FROM schema_migrations WHERE version<=3 ORDER BY version').all()).toEqual(before);
    expect(d.inTransaction).toBe(false);
  });
});

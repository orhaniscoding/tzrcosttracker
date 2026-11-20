export interface AppConfig {
  port: number;
  host: string;
  jwtSecret: string;
  masterKey: string;
  blindIndexPepper: string;
  dbPath?: string;
  bootstrapToken?: string;
}

const PLACEHOLDERS = new Set(['changeme','change-me','change_me','placeholder','replace-me','replace_me','your-secret-here','your_secret_here','default-secret','example-secret','sample-secret']);
function isPlaceholder(v:string):boolean{const n=v.trim().toLowerCase();if(PLACEHOLDERS.has(n))return true;if(n.includes('changeme')||n.includes('change-me')||n.includes('placeholder')||n.includes('your-secret-here')||n.includes('replace-me'))return true;const s=n.replace(/[^a-z0-9]/g,'');return PLACEHOLDERS.has(s)||s==='changeme'||s==='placeholder';}
function secret(value:unknown,envName:string,field:string):string{if(typeof value!=='string'||value.trim().length===0)throw new Error('Invalid configuration: '+envName+'/'+field+' is required and must be a string of at least 32 characters');if(value.trim().length<32||isPlaceholder(value))throw new Error('Invalid configuration: '+envName+'/'+field+' must be at least 32 characters and must not be a placeholder');return value;}
function parsePort(value:unknown):number{if(typeof value==='string'){const t=value.trim();if(!/^\d+$/.test(t))throw new Error('Invalid configuration: PORT/port must be an integer between 1 and 65535');const n=Number(t);if(!Number.isInteger(n)||n<1||n>65535)throw new Error('Invalid configuration: PORT/port must be an integer between 1 and 65535');return n;}if(typeof value!=='number'||!Number.isFinite(value)||!Number.isInteger(value)||value<1||value>65535)throw new Error('Invalid configuration: PORT/port must be an integer between 1 and 65535');return value;}
function host(value:unknown):string{if(typeof value!=='string'||value.trim().length===0)throw new Error('Invalid configuration: HOST/host must be a non-empty string');return value.trim();}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const portRaw = overrides.port !== undefined ? overrides.port : (process.env.PORT !== undefined ? process.env.PORT : 4000);
  const hostRaw = overrides.host !== undefined ? overrides.host : (process.env.HOST !== undefined ? process.env.HOST : '127.0.0.1');
  return {
    port: parsePort(portRaw),
    host: host(hostRaw),
    jwtSecret: secret(overrides.jwtSecret !== undefined ? overrides.jwtSecret : process.env.JWT_SECRET,'JWT_SECRET','jwtSecret'),
    masterKey: secret(overrides.masterKey !== undefined ? overrides.masterKey : process.env.MASTER_KEY,'MASTER_KEY','masterKey'),
    blindIndexPepper: secret(overrides.blindIndexPepper !== undefined ? overrides.blindIndexPepper : process.env.BLIND_INDEX_PEPPER,'BLIND_INDEX_PEPPER','blindIndexPepper'),
    dbPath: overrides.dbPath !== undefined ? overrides.dbPath : (process.env.DB_PATH || 'cost-core.sqlite'),
    bootstrapToken: 'bootstrapToken' in overrides ? overrides.bootstrapToken : process.env.BOOTSTRAP_TOKEN,
  };
}

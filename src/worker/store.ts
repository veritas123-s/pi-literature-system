import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync,readFileSync,existsSync,renameSync} from 'node:fs';
import path from 'node:path';
import {sha256,now,uid} from '../shared/util.ts';
import type {Budget,RunEvent} from '../shared/types.ts';

export class BudgetExhausted extends Error {}
export class UnknownRequest extends Error {}
export class LocalStore {
  db:DatabaseSync; base:string; runId:string; epoch:number; budget:Budget;
  constructor(dataDir:string,runId:string,epoch:number,budget:Budget) {
    if(!/^[A-Za-z0-9_-]+$/.test(runId))throw new Error('Invalid run ID');
    this.base=path.resolve(dataDir,runId);mkdirSync(this.base,{recursive:true});
    this.runId=runId;this.epoch=epoch;this.budget=budget;this.db=new DatabaseSync(path.join(this.base,'local.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,task TEXT,input_hash TEXT,status TEXT,reserved INTEGER,tokens INTEGER,cost REAL,created TEXT,response TEXT);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT,data TEXT,timestamp TEXT);
      CREATE TABLE IF NOT EXISTS results(task TEXT PRIMARY KEY,input_hash TEXT,result TEXT);
    `);
    if(!this.get('startedAt'))this.set('startedAt',Date.now());
  }
  get<T>(key:string):T|undefined {const row=this.db.prepare('SELECT value FROM state WHERE key=?').get(key) as {value:string}|undefined;return row?JSON.parse(row.value):undefined;}
  set(key:string,value:unknown){this.db.prepare('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  event(type:string,data:Record<string,unknown>):RunEvent {const timestamp=now();const result=this.db.prepare('INSERT INTO events(type,data,timestamp) VALUES(?,?,?)').run(type,JSON.stringify(data),timestamp);return {runId:this.runId,epoch:this.epoch,seq:Number(result.lastInsertRowid),type,timestamp,data};}
  events(after=0):RunEvent[]{return (this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq').all(after) as {seq:number;type:string;data:string;timestamp:string}[]).map(r=>({runId:this.runId,epoch:this.epoch,seq:r.seq,type:r.type,timestamp:r.timestamp,data:JSON.parse(r.data)}));}
  usage(){const r=this.db.prepare(`SELECT COUNT(*) requests,COALESCE(SUM(tokens),0) tokens,COALESCE(SUM(cost),0) costUsd,COALESCE(SUM(CASE WHEN status IN ('sent','unknown') THEN 1 ELSE 0 END),0) unknownRequests,COALESCE(SUM(CASE WHEN status IN ('sent','unknown') THEN reserved ELSE 0 END),0) reserved FROM requests`).get() as any;return {requests:Number(r.requests),tokens:Number(r.tokens),costUsd:Number(r.costUsd),costKnown:!this.get<boolean>('costUnknown'),unknownRequests:Number(r.unknownRequests),reserved:Number(r.reserved)};}
  reserve(task:string,inputHash:string,reserved:number){
    if(this.db.prepare("SELECT id FROM requests WHERE task=? AND status IN ('sent','unknown')").get(task))throw new UnknownRequest('该任务存在结果未知的模型请求，需核对后再继续');
    const usage=this.usage();if(usage.requests>=this.budget.maxRequests||usage.tokens+usage.reserved+reserved>this.budget.maxTokens||Date.now()-this.get<number>('startedAt')!>this.budget.maxMinutes*60000||(this.budget.maxCostUsd!==undefined&&usage.costUsd>=this.budget.maxCostUsd))throw new BudgetExhausted('运行预算已到上限');
    const id=uid('request_');this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?)').run(id,task,inputHash,'sent',reserved,0,0,now(),null);return id;
  }
  finishRequest(id:string,response:unknown,tokens:number,cost:number){this.immutable('requests/'+id+'.json',response);this.db.prepare("UPDATE requests SET status='completed',tokens=?,cost=?,response=? WHERE id=?").run(tokens,cost,JSON.stringify(response),id);}
  failRequest(id:string,knownTokens?:number,cost=0){this.db.prepare('UPDATE requests SET status=?,tokens=?,cost=? WHERE id=?').run(knownTokens===undefined?'unknown':'failed',knownTokens??0,cost,id);}
  cached<T>(task:string,inputHash:string):T|undefined {const r=this.db.prepare('SELECT result FROM results WHERE task=? AND input_hash=?').get(task,inputHash) as {result:string}|undefined;return r?JSON.parse(r.result):undefined;}
  completedResponse<T>(task:string,inputHash:string):{id:string;response:T}|undefined {const r=this.db.prepare("SELECT id,response FROM requests WHERE task=? AND input_hash=? AND status='completed' ORDER BY created DESC LIMIT 1").get(task,inputHash) as {id:string;response:string}|undefined;return r?{id:r.id,response:JSON.parse(r.response)}:undefined;}
  cache(task:string,inputHash:string,result:unknown){this.db.prepare('INSERT INTO results VALUES(?,?,?) ON CONFLICT(task) DO UPDATE SET input_hash=excluded.input_hash,result=excluded.result').run(task,inputHash,JSON.stringify(result));}
  immutable(relative:string,value:unknown){const dest=path.resolve(this.base,relative);if(!dest.startsWith(this.base+path.sep))throw new Error('Outside source store');mkdirSync(path.dirname(dest),{recursive:true});const bytes=typeof value==='string'?value:JSON.stringify(value,null,2);if(existsSync(dest)){if(sha256(readFileSync(dest))!==sha256(bytes))throw new Error('Immutable artifact changed');return dest;}writeFileSync(dest,bytes,{flag:'wx'});return dest;}
  checkpoint(value:unknown){this.set('checkpoint',value);const p=path.join(this.base,'checkpoint.json');writeFileSync(p+'.tmp',JSON.stringify(value,null,2));renameSync(p+'.tmp',p);}
  close(){this.db.close();}
}

export class Semaphore {
  active=0;queue:(()=>void)[]=[];constructor(public max:number){}
  async run<T>(fn:()=>Promise<T>):Promise<T>{if(this.active>=this.max)await new Promise<void>(resolve=>this.queue.push(resolve));else this.active++;try{return await fn();}finally{const next=this.queue.shift();if(next)next();else this.active--;}}
}

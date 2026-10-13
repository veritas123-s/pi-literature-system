import {existsSync,mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export function acquireWorkerLock(dataDir:string):()=>void {
  const folder=path.resolve(dataDir);if(folder===path.parse(folder).root)throw new Error('Worker data directory cannot be a drive root');mkdirSync(folder,{recursive:true});const file=path.join(folder,'worker.lock');
  if(existsSync(file)){const previous=JSON.parse(readFileSync(file,'utf8')) as {pid:number;nonce:string};if(!Number.isInteger(previous.pid)||previous.pid<1)throw new Error('Worker lock metadata is invalid');let alive=true;try{process.kill(previous.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;}if(alive)throw new Error('A worker is already running for this data directory');unlinkSync(file);}
  const nonce=randomUUID();writeFileSync(file,JSON.stringify({pid:process.pid,nonce,startedAt:new Date().toISOString()}),{flag:'wx'});return ()=>{if(existsSync(file)){const saved=JSON.parse(readFileSync(file,'utf8'));if(saved.nonce===nonce)unlinkSync(file);}};
}

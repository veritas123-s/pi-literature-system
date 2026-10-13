import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {RunRecord,Command,ResearchBundle,ArtifactManifest,WorkerConfig} from '../shared/types.ts';
import {sha256} from '../shared/util.ts';
import {importBibliography,importPdf} from '../research/imports.ts';
import {dedupePapers} from '../research/sources.ts';
import {loadConfig} from './config.ts';
import {LocalStore,Semaphore} from './store.ts';
import {PiKernel} from './kernel.ts';
import {ResearchPipeline} from './pipeline.ts';

export class CloudClient {
  constructor(public config:WorkerConfig){if(!config.cloudUrl||!config.workerId||!config.workerTokenEnv||!process.env[config.workerTokenEnv])throw new Error('Worker pairing is missing');}
  async call<T=any>(url:string,method='POST',body?:unknown,headers:Record<string,string>={}):Promise<T>{const response=await fetch(this.config.cloudUrl!.replace(/\/$/,'')+url,{method,headers:{Authorization:'Bearer '+process.env[this.config.workerTokenEnv!],...(body instanceof Uint8Array?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:body instanceof Uint8Array?new Uint8Array(body).buffer:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Cloud request failed HTTP '+response.status+' '+url);return response.json() as Promise<T>;}
  async bytes(url:string):Promise<Uint8Array>{const response=await fetch(this.config.cloudUrl!.replace(/\/$/,'')+url,{headers:{Authorization:'Bearer '+process.env[this.config.workerTokenEnv!]},redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error('File receive failed HTTP '+response.status);return new Uint8Array(await response.arrayBuffer());}
}
export function remoteProjection(bundle:ResearchBundle):ResearchBundle {
  const cited=new Set([...bundle.claims.flatMap(c=>c.spanIds),...bundle.paradigms.flatMap(p=>p.steps.flatMap(s=>s.spanIds)),...bundle.findings.flatMap(f=>f.sourceSpanIds)]);
  return {...bundle,documents:bundle.documents.map(d=>({...d,path:'',spans:d.spans.filter(s=>cited.has(s.id)).map(s=>({...s,imagePath:undefined,text:s.text.slice(0,2500)}))}))};
}
export async function executeClaim(config:WorkerConfig,client:CloudClient,run:RunRecord) {
  const store=new LocalStore(config.dataDir,run.id,run.epoch,run.spec.budget);const controller=new AbortController();let stopped=false,networkOkay=true,heartbeatBusy=false;let current=run;let stopCommands:Command[]=[];let settled=false;if(store.get<number>('cloudEpoch')!==run.epoch){const base=store.get<number>('cloudSeq')??0;store.set('cloudBase',base);store.set('cloudEpoch',run.epoch);store.set('cloudSeq',base);}
  const sendEvents=async()=>{const after=store.get<number>('cloudSeq')??0;const base=store.get<number>('cloudBase')??0;const events=store.events(after);for(let i=0;i<events.length;i+=100){const group=events.slice(i,i+100);await client.call('/worker/runs/'+run.id+'/events','POST',{epoch:current.epoch,events:group.map(e=>({...e,seq:e.seq-base}))});store.set('cloudSeq',group.at(-1)!.seq);}};
  const heartbeat=async()=>{if(heartbeatBusy||stopped)return;heartbeatBusy=true;try{const response=await client.call<{run:RunRecord;commands:Command[]}>('/worker/runs/'+run.id+'/heartbeat','POST',{epoch:current.epoch,phase:store.get('phase')??'starting',progress:{...store.usage(),searches:store.get<ResearchBundle>('checkpoint')?.searches.length??0,papers:store.get<ResearchBundle>('checkpoint')?.papers.length??0,evidence:store.get<ResearchBundle>('checkpoint')?.evidence.length??0,fullTextsRead:store.get<ResearchBundle>('checkpoint')?.documents.filter(d=>d.acquisition==='fulltext'&&d.spans.filter(s=>s.kind!=='image').every(s=>d.readSpanIds.includes(s.id))).length??0,checkpoint:store.get('phase')}});current=response.run;networkOkay=true;for(const cmd of response.commands.filter(c=>c.status!=='applied')){if(cmd.kind==='resume'){await client.call(`/worker/runs/${run.id}/commands/${cmd.id}/ack`,'POST',{epoch:current.epoch,status:'applied'});continue;}await client.call(`/worker/runs/${run.id}/commands/${cmd.id}/ack`,'POST',{epoch:current.epoch,status:'received'});if(!stopCommands.some(c=>c.id===cmd.id))stopCommands.push(cmd);if(cmd.kind==='cancel')controller.abort(new Error('Remote cancel'));}await sendEvents();}catch(e){networkOkay=false;store.event('connection_lost',{message:(e as Error).message});}finally{heartbeatBusy=false;}};
  const interval=setInterval(()=>{void heartbeat();},10000);
  const check=async()=>{if(!networkOkay)throw new Error('Lease connectivity lost');if(controller.signal.aborted)throw controller.signal.reason;if(stopCommands.length)throw new Error('Control boundary reached');};
  try {
    const profile=config.modelProfiles[run.spec.modelProfile];if(!profile)throw new Error('Unknown model profile');
    const previous=store.get<ResearchBundle>('checkpoint');if(previous&&previous.spec.scopeVersion!==run.spec.scopeVersion){store.immutable('history/scope-'+previous.spec.scopeVersion+'-'+sha256(JSON.stringify(previous)).slice(0,10)+'.json',previous);store.db.prepare("DELETE FROM state WHERE key='checkpoint'").run();store.set('cloudSeq',store.get<number>('cloudSeq')??0);}
    const pipeline=new ResearchPipeline(store,new PiKernel(store,profile,new Semaphore(config.maxConcurrency),undefined,check),config,run.spec,{checkControl:check,phase:async()=>{await heartbeat();await check();},checkpoint:async bundle=>{await check();await client.call('/worker/runs/'+run.id+'/checkpoint','POST',{epoch:current.epoch,checkpoint:{phase:store.get('phase'),scopeVersion:run.spec.scopeVersion,localCheckpointHash:sha256(JSON.stringify(bundle)),localState:true,workerId:config.workerId,lastEventSeq:store.events().at(-1)?.seq??0}});}});
    const uploads=await client.call<{uploads?:any[]}|any[]>('/worker/runs/'+run.id+'/uploads?epoch='+current.epoch,'GET');
    for(const upload of (Array.isArray(uploads)?uploads:uploads.uploads??[])){const bytes=await client.bytes(`/worker/runs/${run.id}/uploads/${upload.id}?epoch=${current.epoch}`);const hash=sha256(bytes);if(upload.sha256&&upload.sha256!==hash)throw new Error('Imported file hash mismatch');const dir=path.join(store.base,'imports');mkdirSync(dir,{recursive:true});const filename=upload.name??upload.filename??'import.pdf';const extension=path.extname(filename).toLowerCase();if(!['.pdf','.ris','.bib','.bibtex'].includes(extension))throw new Error('Unsupported import format');const local=path.join(dir,hash+extension);if(!existsSync(local))writeFileSync(local,bytes);
      if(extension==='.pdf'){const paper={id:'import_'+hash.slice(0,20),source:'import' as const,title:filename,authors:[],identityVerified:false};pipeline.bundle.papers=dedupePapers([...pipeline.bundle.papers,paper]);pipeline.bundle.screening.push({paperId:paper.id,decision:'uncertain',reason:'用户导入PDF，仍需题录与相关性核验'});pipeline.bundle.documents.push(await importPdf(local,paper,path.join(store.base,'sources'),config.pythonPath));}else pipeline.bundle.papers=dedupePapers([...pipeline.bundle.papers,...await importBibliography(local)]);await pipeline.save();await client.call(`/worker/runs/${run.id}/uploads/${upload.id}/received`,'POST',{epoch:current.epoch,sha256:hash});
    }
    const result=await pipeline.run(controller.signal);await check();await sendEvents();
    const remote=remoteProjection(result.bundle);const bundleFile=path.join(result.artifactDir,'remote-bundle.json');writeFileSync(bundleFile,JSON.stringify(remote,null,2));
    // Upload owner-readable outputs; raw local bundle and source corpus stay on the worker.
    const files=result.manifest.files.filter(f=>!['bundle.json','research.json'].includes(f.name));const bytes=readFileSync(bundleFile);const remoteFile={name:'bundle.json',mime:'application/json',sha256:sha256(bytes),size:bytes.length};const manifest:ArtifactManifest={version:result.manifest.version,files:[...files,remoteFile]};
    for(const f of manifest.files){await check();const bytes=readFileSync(f.name==='bundle.json'?bundleFile:path.join(result.artifactDir,f.name));await client.call(`/worker/runs/${run.id}/artifacts/${manifest.version}/${f.name}`,'POST',bytes,{'Content-Type':'application/octet-stream','x-artifact-mime':f.mime,'x-run-epoch':String(current.epoch)});}
    await client.call('/worker/runs/'+run.id+'/complete','POST',{epoch:current.epoch,status:result.bundle.status,manifest,gaps:result.bundle.gaps});settled=true;
  }catch(e){store.event('worker_stopped',{message:(e as Error).message});if(networkOkay){try{await heartbeat();await sendEvents();const cancel=stopCommands.find(c=>c.kind==='cancel');const scope=stopCommands.find(c=>c.kind==='scope');const command=cancel??scope??stopCommands.find(c=>c.kind==='pause');if(command)await client.call(`/worker/runs/${run.id}/commands/${command.id}/ack`,'POST',{epoch:current.epoch,status:'applied',...(command.kind==='scope'?{pauseAfterApply:true}:{})});else await client.call('/worker/runs/'+run.id+'/fail','POST',{epoch:current.epoch,error:(e as Error).message,gaps:['本地检查点保留']});settled=true;}catch{store.event('control_ack_pending',{});}}}
  finally{stopped=true;clearInterval(interval);store.set('lastCloudRun',{id:run.id,epoch:current.epoch});store.close();}return settled;
}
export async function runWorker(config:WorkerConfig,signal?:AbortSignal){
  const client=new CloudClient(config);mkdirSync(config.dataDir,{recursive:true});const stateFile=path.join(config.dataDir,'worker-state.json');
  const load=()=>existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')) as {pending:{id:string;epoch:number}|null}:{pending:null};
  const save=(pending:{id:string;epoch:number}|null)=>writeFileSync(stateFile,JSON.stringify({pending}));
  while(!signal?.aborted){try{
    let run:RunRecord|null=null;const pending=load().pending;
    if(pending){const status=await client.call<{status:string;epoch:number;leaseUntil:number|null}>(`/worker/runs/${pending.id}/status`,'GET');
      if(['completed','completed_with_gaps','failed','cancelled','paused','queued'].includes(status.status)){save(null);continue;}
      if(status.epoch!==pending.epoch)throw new Error('Execution epoch changed; this worker must not reclaim an unknown executor');
      if(status.leaseUntil&&status.leaseUntil>Date.now()){const r=await client.call<{run:RunRecord}>(`/worker/runs/${pending.id}/heartbeat`,'POST',{epoch:pending.epoch});run=r.run;}
      else run=(await client.call<{run:RunRecord}>('/worker/recover','POST',{runId:pending.id,previousEpoch:pending.epoch})).run;
    }else run=(await client.call<{run:RunRecord|null}>('/worker/claim')).run;
    if(run){save({id:run.id,epoch:run.epoch});const settled=await executeClaim(config,client,run);if(settled)save(null);}
    else await delay(5000,undefined,{signal});
  }catch(e){if(signal?.aborted)break;console.error('执行端等待连接：'+(e as Error).message);await delay(5000,undefined,{signal});}}
}
if(process.argv[1]?.endsWith('main.ts')){const signal=new AbortController();process.on('SIGINT',()=>signal.abort());process.on('SIGTERM',()=>signal.abort());await runWorker(loadConfig(),signal.signal);}

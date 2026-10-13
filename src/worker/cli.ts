import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import type {RunSpec} from '../shared/types.ts';
import {uid} from '../shared/util.ts';
import {loadConfig} from './config.ts';
import {LocalStore,Semaphore} from './store.ts';
import {PiKernel} from './kernel.ts';
import {ResearchPipeline} from './pipeline.ts';
import {importBibliography,importPdf} from '../research/imports.ts';
import {sha256} from '../shared/util.ts';
const argv=process.argv.slice(2);const option=(key:string)=>{const n=argv.indexOf(key);return n>=0?argv[n+1]:undefined;};
const config=loadConfig(option('--config'));
if(argv[0]==='doctor'){
  const result={node:process.version,dataDir:config.dataDir,pythonConfigured:!!config.pythonPath&&existsSync(config.pythonPath),fontConfigured:!!config.fontPath&&existsSync(config.fontPath),cloudConfigured:!!config.cloudUrl,workerPaired:!!config.workerId&&!!config.workerTokenEnv&&!!process.env[config.workerTokenEnv],models:Object.entries(config.modelProfiles).map(([name,p])=>({name,provider:p.provider,model:p.model,configured:p.provider==='codex-cli'?spawnSync(process.env.PI_LITERATURE_CODEX??'codex',['--version'],{windowsHide:true}).status===0:!!process.env[p.apiKeyEnv]}))};console.log(JSON.stringify(result,null,2));
}else if(argv[0]==='run'){
  const topic=option('--topic');if(!topic)throw new Error('Provide --topic');const id=option('--resume')??uid('local_');
  const spec:RunSpec={topic,focus:option('--focus'),sources:['pubmed','europepmc','openalex'],cutoffDate:option('--cutoff')??new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),language:'zh',modelProfile:option('--profile')??Object.keys(config.modelProfiles)[0],budget:config.defaultBudget,scopeVersion:1,maxRepairRounds:3};
  const store=new LocalStore(config.dataDir,id,1,spec.budget);const controller=new AbortController();process.on('SIGINT',()=>controller.abort(new Error('Local stop')));
  try{const pipeline=new ResearchPipeline(store,new PiKernel(store,config.modelProfiles[spec.modelProfile],new Semaphore(config.maxConcurrency)),config,spec,{phase:async(phase,bundle)=>console.log(JSON.stringify({runId:id,phase,papers:bundle.papers.length,evidence:bundle.evidence.length,usage:store.usage()}))});
    for(let i=0;i<argv.length;i++)if(argv[i]==='--import'&&argv[i+1]){const file=path.resolve(argv[i+1]);if(path.extname(file).toLowerCase()==='.pdf'){const paper={id:'import_'+sha256(readFileSync(file)).slice(0,20),source:'import' as const,title:path.basename(file),authors:[],identityVerified:false};pipeline.bundle.papers.push(paper);pipeline.bundle.documents.push(await importPdf(file,paper,path.join(store.base,'sources'),config.pythonPath));}else pipeline.bundle.papers.push(...await importBibliography(file));}
    const result=await pipeline.run(controller.signal);console.log(JSON.stringify({runId:id,status:result.bundle.status,artifactDir:result.artifactDir,gaps:result.bundle.gaps,usage:result.bundle.usage},null,2));
  }finally{store.close();}
}else throw new Error('Supported commands: doctor, run');

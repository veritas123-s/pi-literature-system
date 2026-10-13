import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {loadConfig} from '../src/worker/config.ts';
import {LocalStore,Semaphore} from '../src/worker/store.ts';
import {PiKernel} from '../src/worker/kernel.ts';
import {ResearchPipeline} from '../src/worker/pipeline.ts';
import {sha256} from '../src/shared/util.ts';
import type {RunSpec,WorkerConfig} from '../src/shared/types.ts';
import {runBenchmarkPairs,type BenchmarkRunnerAdapter} from './benchmark.ts';

export function createPiBenchmarkAdapter(config:WorkerConfig,profileName:string,cutoffDate:string):BenchmarkRunnerAdapter {
  const profile=config.modelProfiles[profileName];if(!profile)throw new Error('Unknown benchmark model profile');
  return {async execute(input){
    if(input.modelProfileHash!==sha256(JSON.stringify(profile)))throw new Error('Benchmark model profile changed');
    const receiptFile=join(input.outputDir,'execution.json');
    if(existsSync(receiptFile)){const saved=JSON.parse(await readFile(receiptFile,'utf8'));if(saved.arm!==input.arm||saved.modelProfileHash!==input.modelProfileHash||saved.cutoffDate!==cutoffDate||JSON.stringify(saved.budget)!==JSON.stringify(input.budget)||JSON.stringify(saved.tools)!==JSON.stringify(input.tools))throw new Error('Completed benchmark settings changed');if(!saved.bundle||sha256(await readFile(saved.bundle.path))!==saved.bundle.sha256)throw new Error('Completed benchmark output changed');return saved.bundle;}
    const dataDir=join(resolve(input.outputDir),'worker');await mkdir(dataDir,{recursive:true});
    const id='benchmark_'+input.case.id+'_'+input.arm;
    const spec:RunSpec={topic:input.case.topic,focus:input.case.questions.join('；'),sources:['pubmed','europepmc','openalex','crossref'],cutoffDate,language:'zh',modelProfile:profileName,budget:{...input.budget},scopeVersion:1,maxRepairRounds:3};
    const store=new LocalStore(dataDir,id,1,spec.budget);
    try{const kernel=new PiKernel(store,profile,new Semaphore(config.maxConcurrency),undefined,undefined,input.arm==='single_agent'?'single':'isolated');
      const pipeline=new ResearchPipeline(store,kernel,{...config,dataDir},spec,{phase:async phase=>console.log(JSON.stringify({caseId:input.case.id,arm:input.arm,phase,usage:store.usage()}))});
      const result=await pipeline.run();const path=join(result.artifactDir,'research.json');const bytes=await readFile(path);
      const bundle={path,sha256:sha256(bytes)};await writeFile(receiptFile,JSON.stringify({arm:input.arm,roles:input.roles,sessionMode:kernel.sessionMode,modelProfileHash:input.modelProfileHash,cutoffDate,tools:input.tools,budget:input.budget,bundle,usage:result.bundle.usage,status:result.bundle.status,scientificAcceptance:false},null,2),{flag:'wx'});
      return bundle;
    }finally{store.close();}
  }};
}
async function main(){
  const args=process.argv.slice(2);if(args[0]!=='run'||!args[1])throw new Error('Usage: run-benchmark.ts run OUTPUT_DIR [CONFIG_FILE] [PROFILE] [CUTOFF_DATE]. Starts eight real runs, each with the configured budget.');
  const config=loadConfig(args[2]),profileName=args[3]??Object.keys(config.modelProfiles)[0],profile=config.modelProfiles[profileName];if(!profile)throw new Error('Unknown model profile');
  const cutoff=args[4]??new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());if(!/^\d{4}-\d{2}-\d{2}$/.test(cutoff))throw new Error('Invalid cutoff date');
  const outputDir=resolve(args[1]);await mkdir(outputDir,{recursive:true});
  const tools=['pubmed','europepmc','openalex','crossref','citation_chasing','source_read','source_image','evidence_read'];
  const settings={modelProfileHash:sha256(JSON.stringify(profile)),tools,budget:{...config.defaultBudget},outputDir};
  const registration=join(outputDir,'preregistration.json');if(existsSync(registration)){const previous=JSON.parse(await readFile(registration,'utf8'));if(previous.modelProfileHash!==settings.modelProfileHash||previous.cutoff!==cutoff||JSON.stringify(previous.tools)!==JSON.stringify(tools)||JSON.stringify(previous.budget)!==JSON.stringify(settings.budget))throw new Error('Preregistered benchmark settings changed');}else await writeFile(registration,JSON.stringify({...settings,cutoff,createdAt:new Date().toISOString(),humanAssessment:'pending'},null,2),{flag:'wx'});
  const receipts=await runBenchmarkPairs(createPiBenchmarkAdapter(config,profileName,cutoff),settings);await writeFile(join(outputDir,'receipts.json'),JSON.stringify(receipts,null,2));console.log('Paired runs saved. No scientific score is assigned without independent human review.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error((error as Error).message);process.exitCode=1;});

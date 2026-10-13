import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {LiteratureClient,dedupePapers} from '../src/research/sources.ts';
import type {SourceName} from '../src/shared/types.ts';

// Genuine public API probe; intentionally invokes no model and computes no quality score.
const topic=process.argv[2]??'IgG4-related disease molecular imaging';
const outDir=process.argv[3]??join(process.cwd(),'work','live-probe');
const cutoff=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
const client=new LiteratureClient({maxRecords:10,email:process.env.LITERATURE_EMAIL,timeoutMs:30000});
await mkdir(outDir,{recursive:true});
const sources:SourceName[]=['pubmed','europepmc','openalex','crossref'];
const results=await Promise.allSettled(sources.map(s=>client.search(s,topic,cutoff)));
const outputs=results.map((r,i)=>r.status==='fulfilled'?r.value:{papers:[],log:{source:sources[i],error:String(r.reason),paginationComplete:false}});
const papers=dedupePapers(outputs.flatMap(o=>o.papers));
const sample=papers.find(p=>p.pmcid&&p.abstract)??papers.find(p=>p.abstract);
const fulltext=sample?await client.fullText(sample,outDir):undefined;
const result={executedAt:new Date().toISOString(),topic,cutoff,sources:outputs.map(o=>o.log),distinctPapers:papers.length,sampleFulltext:fulltext?{paperId:fulltext.paperId,acquisition:fulltext.acquisition,parsing:fulltext.parsing,spans:fulltext.spans.length,path:fulltext.path}:null,papers,qualityAssessment:'Not assessed; live retrieval probe only'};
await writeFile(join(outDir,'probe.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,papers:undefined},null,2));

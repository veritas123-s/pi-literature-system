import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {Type} from 'typebox';
import {LocalStore,Semaphore} from '../src/worker/store.ts';
import {PiKernel,jsonTool} from '../src/worker/kernel.ts';
import {LiteratureClient} from '../src/research/sources.ts';
const root=path.resolve('work/live-pi');mkdirSync(root,{recursive:true});
const client=new LiteratureClient({maxRecords:3});const result=await client.search('europepmc','TSHR AND Graves AND OPEN_ACCESS:Y',new Date().toISOString().slice(0,10));
const paper=result.papers.find(p=>p.pmcid);if(!paper)throw new Error('No accessible fulltext');const doc=await client.fullText(paper,root);const spans=doc.spans.filter(s=>s.text.length>300).slice(0,2);
const store=new LocalStore(root,'live_probe_protocol2',1,{maxTokens:160000,maxRequests:5,maxMinutes:20});
const read=new Set<string>();const tool=jsonTool('source_read','Read immutable source span by actual ID',Type.Object({id:Type.String()},{additionalProperties:false}),async args=>{const span=spans.find(s=>s.id===args.id);if(!span)throw new Error('Invalid source ID');read.add(span.id);return span;});
const kernel=new PiKernel(store,{provider:'codex-cli',model:process.env.PI_LITERATURE_TEST_MODEL??'gpt-6.1-sol',apiKeyEnv:'',contextWindow:200000,maxOutputTokens:3000,reasoning:'high'},new Semaphore(1));
try{const output=await kernel.execute<{quotes:{spanId:string;quote:string;interpretation:string}[];limits:string[]}>('analyst','actual-source-probe',{paper,index:spans.map(s=>({id:s.id,locator:s.locator}))},'Read every listed source using source_read. Return JSON {quotes:[{spanId,quote,interpretation}],limits:[string]}. quote must be a verbatim substring of the source, interpretation in Chinese with no extra facts. This is a transport/tool probe, not a scientific acceptance.',[tool]);
  const verified=output.quotes.length>0&&output.quotes.every(q=>read.has(q.spanId)&&spans.find(s=>s.id===q.spanId)?.text.includes(q.quote))&&spans.every(s=>read.has(s.id));
  const report={kind:'real_model_tool_probe',scientificAcceptance:false,verified,paper,sourceHash:doc.hash,readSpans:[...read],output,usage:store.usage()};writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({verified,scientificAcceptance:false,source:paper.id,usage:store.usage()}));if(!verified)throw new Error('Probe citation mismatch');
}finally{store.close();}

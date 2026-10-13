import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ResearchBundle,Budget,Role} from '../src/shared/types.ts';
import {sha256} from '../src/shared/util.ts';
import {csv,validateCitations} from '../src/research/exports.ts';

export type BenchmarkArm='single_agent'|'four_agents';
export const BENCHMARK_CASES=[
  {id:'clinical',discipline:'临床研究',topic:'重度哮喘生物制剂 随机对照研究 疗效与安全性',questions:['对照、随机化、盲法和终点','阴性结局、亚组与外推限制']},
  {id:'mechanism',discipline:'基础机制',topic:'甲状腺眼病 TSHR 与 IGF-1R 信号及眶成纤维细胞机制',questions:['通路关联与功能干预','替代解释、救援实验和物种边界']},
  {id:'bioinformatics',discipline:'生物信息学',topic:'溃疡性结肠炎 单细胞转录组 巨噬细胞状态与验证',questions:['独立供者、批次、统计单位和外部验证','细胞通讯推断和功能证据边界']},
  {id:'imaging',discipline:'分子影像',topic:'IgG4 相关疾病 FAPI PET 成像 诊断与纤维化评估',questions:['参考标准、配对比较和病例选择','示踪剂摄取与病理机制的证据边界']},
] as const;
export const BENCHMARK_FIELDS=['population','sampleSize','groups','intervention','comparator','endpoints','results','uncertainty','statistics','limitations'] as const;
export interface SourceReceipt {path:string;sha256:string}
export interface HoldoutStudy {id:string;paperIds:string[];key:boolean;majorCounterEvidence:boolean;sources:SourceReceipt[]}
export interface HumanGrade {reviewerId:string;originalSourceChecked:boolean}
export interface Assessment {
  studies:({studyId:string;representedCorrectly:boolean;reportLocation:string}&HumanGrade)[];
  claims:({claimId:string;supported:boolean;seriousDistortion:boolean;sourceHashes:string[]}&HumanGrade)[];
  fields:({evidenceId:string;field:typeof BENCHMARK_FIELDS[number];correct:boolean;sourceHash:string}&HumanGrade)[];
  paradigms:({paradigmId:string;allStepsTraceable:boolean;suggestionsDistinguished:boolean}&HumanGrade)[];
  coreNumbersChecked:boolean;
}
export interface ArmReceipt {bundle:SourceReceipt;modelProfileHash:string;tools:string[];budget:Budget;assessment:Assessment}
export interface BenchmarkCaseInput {id:typeof BENCHMARK_CASES[number]['id'];developmentPaperIds:string[];holdout:HoldoutStudy[];arms:Record<BenchmarkArm,ArmReceipt>}
export interface BenchmarkInput {
  version:1;preregisteredAt:string;sealedAt:string;referenceCuratorId:string;independentReviewerId:string;
  splitAttestation:{reviewerId:string;holdoutNotUsedForDevelopment:boolean;labelsNotProvidedToAgents:boolean;attestedAt:string};
  cases:BenchmarkCaseInput[];
}
export interface BenchmarkRunnerAdapter {
  /** Implement with PiKernel; no hidden labels or assessment material are passed to the adapter. */
  execute(input:{arm:BenchmarkArm;roles:Role[];case:typeof BENCHMARK_CASES[number];modelProfileHash:string;tools:string[];budget:Budget;outputDir:string}):Promise<SourceReceipt>;
}
export async function runBenchmarkPairs(adapter:BenchmarkRunnerAdapter,config:{modelProfileHash:string;tools:string[];budget:Budget;outputDir:string}){
  if(!/^[a-f0-9]{64}$/i.test(config.modelProfileHash)||!config.tools.length)throw new Error('Paired benchmark requires model profile hash and explicit identical tools');
  const receipts=[];for(const item of BENCHMARK_CASES)for(const arm of ['single_agent','four_agents'] as const){const outputDir=join(config.outputDir,item.id,arm);await mkdir(outputDir,{recursive:true});const bundle=await adapter.execute({arm,roles:arm==='single_agent'?['researcher']:['researcher','analyst','synthesist','auditor'],case:item,modelProfileHash:config.modelProfileHash,tools:[...config.tools],budget:{...config.budget},outputDir});if(sha256(await readFile(bundle.path))!==bundle.sha256)throw new Error('Runner returned changed bundle');receipts.push({caseId:item.id,arm,bundle,modelProfileHash:config.modelProfileHash,tools:config.tools,budget:config.budget,assessment:'pending independent human review'});}return receipts;
}
function check(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
function checkedGrade(g:HumanGrade,reviewer:string){check(g?.reviewerId===reviewer&&g.originalSourceChecked===true,'Independent reviewer and original-source check are required for every graded item');}
function noDuplicates(ids:string[],label:string){check(new Set(ids).size===ids.length,`Duplicate ${label}`);}
function sameBudget(a:Budget,b:Budget){return ['maxTokens','maxRequests','maxMinutes','maxCostUsd'].every(k=>a[k as keyof Budget]===b[k as keyof Budget]);}
function canonical(id:string){return id.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'doi:').toLowerCase();}
function paperKeys(p:ResearchBundle['papers'][number]){return[p.id,p.doi?`doi:${p.doi}`:'',p.pmid?`pmid:${p.pmid}`:'',p.pmcid?`pmcid:${p.pmcid}`:''].filter(Boolean).map(canonical);}
export async function evaluateBenchmark(input:BenchmarkInput,baseDir=process.cwd()){
  check(input?.version===1,'Unsupported benchmark contract');check(Number.isFinite(Date.parse(input.preregisteredAt))&&Number.isFinite(Date.parse(input.sealedAt))&&Date.parse(input.preregisteredAt)<=Date.parse(input.sealedAt),'Valid preregistration and holdout sealing timestamps are required');
  check(input.referenceCuratorId?.trim()&&input.independentReviewerId?.trim()&&input.referenceCuratorId!==input.independentReviewerId,'Reference curator and a separate independent human reviewer are required');
  const split=input.splitAttestation;check(split?.reviewerId===input.independentReviewerId&&split.holdoutNotUsedForDevelopment===true&&split.labelsNotProvidedToAgents===true&&Number.isFinite(Date.parse(split.attestedAt)),'Unseen holdout split and no label leakage must be independently attested');
  check(Array.isArray(input.cases)&&input.cases.length===4&&BENCHMARK_CASES.every(c=>input.cases.some(x=>x.id===c.id)),'Exactly the four fixed discipline cases are required');noDuplicates(input.cases.map(c=>c.id),'case IDs');const rows=[];
  const load=async(receipt:SourceReceipt)=>{check(receipt?.path&&/^[a-f0-9]{64}$/i.test(receipt.sha256),'A source path and SHA-256 fingerprint are required');const bytes=await readFile(resolve(baseDir,receipt.path));check(sha256(bytes)===receipt.sha256,`Source fingerprint mismatch: ${receipt.path}`);return bytes;};
  for(const item of input.cases){check(Array.isArray(item.developmentPaperIds)&&item.holdout?.length,'Development split and nonempty holdout are required');noDuplicates(item.holdout.map(s=>s.id),'holdout study IDs');const development=new Set(item.developmentPaperIds.map(canonical));
    for(const study of item.holdout){check(study.id&&study.paperIds?.length&&study.sources?.length,'Each holdout study requires publication identities and original-source fingerprints');check(study.paperIds.every(id=>!development.has(canonical(id))),'Holdout overlaps development material');for(const source of study.sources)await load(source);}
    check(item.holdout.some(s=>s.key)&&item.holdout.some(s=>s.majorCounterEvidence),'Each case requires key studies and major counter-evidence');
    const a=item.arms.single_agent,b=item.arms.four_agents;check(a&&b,'Both single-agent baseline and four-agent run are required');check(/^[a-f0-9]{64}$/i.test(a.modelProfileHash)&&a.modelProfileHash===b.modelProfileHash,'Arms must use the same hash-identified model profile');check(a.tools?.length&&JSON.stringify([...a.tools].sort())===JSON.stringify([...b.tools].sort()),'Arms must use identical tools');check(sameBudget(a.budget,b.budget),'Arms must use identical budgets');
    for(const arm of ['single_agent','four_agents'] as const){const receipt=item.arms[arm];const bundle=JSON.parse((await load(receipt.bundle)).toString('utf8')) as ResearchBundle;validateCitations(bundle);check(sameBudget(bundle.spec.budget,receipt.budget),'Bundle budget differs from paired receipt');check(bundle.spec.topic===BENCHMARK_CASES.find(c=>c.id===item.id)!.topic,'Bundle does not match the preregistered case topic');
      const assessment=receipt.assessment;check(assessment&&Array.isArray(assessment.studies)&&Array.isArray(assessment.claims)&&Array.isArray(assessment.fields)&&Array.isArray(assessment.paradigms),'Human assessment tables are required');check(assessment.coreNumbersChecked===true,'Core numerical values, units, denominators and uncertainty must be independently checked');
      noDuplicates(assessment.studies.map(g=>g.studyId),'study grades');noDuplicates(assessment.claims.map(g=>g.claimId),'claim grades');noDuplicates(assessment.fields.map(g=>g.evidenceId+':'+g.field),'field grades');noDuplicates(assessment.paradigms.map(g=>g.paradigmId),'paradigm grades');
      check(item.holdout.every(s=>assessment.studies.some(g=>g.studyId===s.id))&&assessment.studies.every(g=>item.holdout.some(s=>s.id===g.studyId)),'Every hidden study must receive one human coverage grade');
      const papers=new Set(bundle.papers.flatMap(paperKeys));for(const grade of assessment.studies){checkedGrade(grade,input.independentReviewerId);if(grade.representedCorrectly){const study=item.holdout.find(s=>s.id===grade.studyId)!;check(study.paperIds.some(id=>papers.has(canonical(id)))&&grade.reportLocation?.trim(),'Covered study must actually be retrieved and have a report location');}}
      check(bundle.claims.length>0&&bundle.claims.filter(c=>c.core).every(c=>assessment.claims.some(g=>g.claimId===c.id)),'All core claims must receive independent support grades');const spans=new Map(bundle.documents.flatMap(d=>d.spans).map(s=>[s.id,s]));const sourceHashes=new Set(bundle.documents.map(d=>d.hash));
      for(const grade of assessment.claims){checkedGrade(grade,input.independentReviewerId);const claim=bundle.claims.find(c=>c.id===grade.claimId);check(claim,'Grade points to unknown claim');check(grade.sourceHashes?.length&&grade.sourceHashes.every(h=>sourceHashes.has(h)&&claim.spanIds.some(id=>spans.get(id)?.sourceHash===h)),'Claim support grade requires original source hashes related to its citations');}
      check(assessment.claims.length>0&&assessment.fields.length>0,'Nonempty support and extraction samples are required');
      for(const grade of assessment.fields){checkedGrade(grade,input.independentReviewerId);const e=bundle.evidence.find(e=>e.id===grade.evidenceId);check(e&&BENCHMARK_FIELDS.includes(grade.field)&&grade.sourceHash===e.sourceHash,'Field grade requires an actual extraction field and matching source hash');}
      check(bundle.evidence.every(e=>assessment.fields.some(g=>g.evidenceId===e.id&&g.field==='sampleSize')&&assessment.fields.some(g=>g.evidenceId===e.id&&g.field==='results')),'Sample size and results must be checked for every extracted evidence record');
      check(bundle.paradigms.length>0&&bundle.paradigms.every(p=>assessment.paradigms.some(g=>g.paradigmId===p.id)),'Every generated paradigm requires independent source and suggestion checks');for(const grade of assessment.paradigms){checkedGrade(grade,input.independentReviewerId);check(bundle.paradigms.some(p=>p.id===grade.paradigmId),'Unknown paradigm grade');}
      // Recompute byte fingerprints for every cited worker source, not just submitted reference labels.
      for(const doc of bundle.documents)if(bundle.claims.some(c=>c.spanIds.some(id=>doc.spans.some(s=>s.id===id))))await load({path:doc.path,sha256:doc.hash});
      const key=item.holdout.filter(s=>s.key),counter=item.holdout.filter(s=>s.majorCounterEvidence);const correctStudies=new Set(assessment.studies.filter(g=>g.representedCorrectly).map(g=>g.studyId));const recall=key.filter(s=>correctStudies.has(s.id)).length/key.length;const support=assessment.claims.filter(g=>g.supported&&!g.seriousDistortion).length/assessment.claims.length;const extraction=assessment.fields.filter(g=>g.correct).length/assessment.fields.length;const counters=counter.every(s=>correctStudies.has(s.id));const paradigms=assessment.paradigms.every(g=>g.allStepsTraceable&&g.suggestionsDistinguished);const coreTraceability=bundle.claims.filter(c=>c.core).every(c=>c.spanIds.length>0&&c.evidenceIds.length>0);const noSeriousDistortion=assessment.claims.every(g=>!g.seriousDistortion);
      rows.push({caseId:item.id,arm,scientific:{status:recall>=.9&&support>=.95&&extraction>=.95&&counters&&paradigms&&coreTraceability&&noSeriousDistortion?'target_met':'below_target',recall,supportAccuracy:support,fieldAccuracy:extraction,majorCounterEvidenceRepresented:counters,paradigmsTraceable:paradigms,coreTraceability,noSeriousDistortion,humanReviewer:input.independentReviewerId},engineering:{citationGraphValid:true,sourceFingerprintsValid:true,bundleSha256:receipt.bundle.sha256,usage:bundle.usage,runStatus:bundle.status},sampleSizes:{keyStudies:key.length,claims:assessment.claims.length,fields:assessment.fields.length,paradigms:assessment.paradigms.length}});
    }
  }
  return {version:1,evaluatedAt:new Date().toISOString(),scientificStatus:rows.every(r=>r.scientific.status==='target_met')?'all_targets_met':'some_targets_not_met',evidenceBoundary:'Scores derive from supplied independent human source grades and a signed unseen-split attestation. The evaluator cannot independently prove historical non-leakage or constitute scientific publication approval.',rows};
}
export function benchmarkTemplate(){return {version:1,preregisteredAt:'',sealedAt:'',referenceCuratorId:'',independentReviewerId:'',splitAttestation:{reviewerId:'',holdoutNotUsedForDevelopment:false,labelsNotProvidedToAgents:false,attestedAt:''},cases:BENCHMARK_CASES.map(c=>({id:c.id,topic:c.topic,developmentPaperIds:[],holdout:[],arms:{single_agent:null,four_agents:null}})),state:'not_evaluated; holdout, paired real runs, source hashes and independent human grades required'};}
async function main(){const [command,inputPath,outDir]=process.argv.slice(2);if(command==='init'&&inputPath){await mkdir(dirname(resolve(inputPath)),{recursive:true});await writeFile(inputPath,JSON.stringify(benchmarkTemplate(),null,2));console.log('Benchmark template created; no scientific score has been computed.');return;}if(command!=='evaluate'||!inputPath||!outDir)throw new Error('Usage: benchmark.ts init template.json OR evaluate assessed-input.json output-directory');
  const input=JSON.parse(await readFile(inputPath,'utf8')) as BenchmarkInput;const result=await evaluateBenchmark(input,dirname(resolve(inputPath)));await mkdir(outDir,{recursive:true});await writeFile(join(outDir,'benchmark.json'),JSON.stringify(result,null,2));await writeFile(join(outDir,'benchmark.csv'),csv(result.rows.map(r=>({caseId:r.caseId,arm:r.arm,...r.scientific,...r.sampleSizes,engineering:JSON.stringify(r.engineering)}))));console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'not_evaluated',reason:(e as Error).message}));process.exitCode=2;});

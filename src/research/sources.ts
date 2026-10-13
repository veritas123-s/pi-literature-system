import {XMLParser, XMLValidator} from 'fast-xml-parser';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import type {Paper, SearchLog, SourceDocument, SourceName, SourceSpan} from '../shared/types.ts';
import {now, sha256, uid} from '../shared/util.ts';

export interface LiteratureOptions {email?:string; timeoutMs?:number; maxRecords?:number; fetchImpl?:typeof fetch; skipDnsCheck?:boolean;skipRateLimit?:boolean;beforeRequest?:()=>void|Promise<void>}
export interface SearchResult {papers:Paper[];log:SearchLog}
const HOSTS=new Set(['eutils.ncbi.nlm.nih.gov','www.ebi.ac.uk','www.ebi.ac.uk','api.openalex.org','api.crossref.org','europepmc.org']);
const nextHostRequest=new Map<string,number>();
async function delay(ms:number,signal?:AbortSignal){if(ms<=0)return;signal?.throwIfAborted();await new Promise<void>((resolve,reject)=>{const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};const timer=setTimeout(finish,ms);const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason??new Error('Aborted'));};signal?.addEventListener('abort',abort,{once:true});});}
async function rateLimit(host:string,signal?:AbortSignal){const current=Date.now();const slot=Math.max(current,nextHostRequest.get(host)??0);nextHostRequest.set(host,slot+(host==='eutils.ncbi.nlm.nih.gov'?350:100));await delay(slot-current,signal);}
const arr=<T>(v:T|T[]|undefined):T[]=>v===undefined?[]:Array.isArray(v)?v:[v];
const clean=(v:unknown):string=>typeof v==='string'?v.replace(/\s+/g,' ').trim():typeof v==='number'?String(v):v&&typeof v==='object'?Object.entries(v).filter(([k])=>!k.startsWith('@_')).map(([,x])=>clean(x)).join(' ').replace(/\s+/g,' ').trim():'';
export function plainTitle(raw:string):string{const entities:Record<string,string>={lt:'<',gt:'>',amp:'&',quot:'"',apos:"'"};let value=raw;for(let i=0;i<2;i++)value=value.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[a-f0-9]+);/gi,(_,entity:string)=>{if(entities[entity.toLowerCase()])return entities[entity.toLowerCase()];const code=entity.toLowerCase().startsWith('#x')?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';});return value.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();}
export const normalizeDoi=(s:string)=>s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi:\s*/i,'').trim().toLowerCase();
function publicAddress(ip:string):boolean {
  const low=ip.toLowerCase();
  if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127));}
  return isIP(ip)===6&&!(/^(::$|::1$|f[cd]|fe[89ab]|::ffff:)/i.test(low));
}
/** No arbitrary publisher URLs or redirect following. Only known public literature APIs. */
export async function assertLiteratureUrl(raw:string,checkDns=true):Promise<URL>{
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!HOSTS.has(url.hostname))throw new Error('Remote source URL is outside the public literature API allowlist');
  if(checkDns){const addresses=await lookup(url.hostname,{all:true});if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('Remote source resolves to a non-public address');}
  return url;
}
function invertedAbstract(index:Record<string,number[]>|null|undefined):string|undefined {if(!index)return;const words:string[]=[];for(const [word,positions]of Object.entries(index))for(const p of positions)if(p>=0&&p<100000)words[p]=word;return words.join(' ');}
function paperFromOpenAlex(w:any):Paper{return {id:w.id,source:'openalex',title:plainTitle(w.display_name??''),authors:(w.authorships??[]).map((x:any)=>x.author?.display_name).filter(Boolean),year:w.publication_year,journal:w.primary_location?.source?.display_name,doi:w.doi?normalizeDoi(w.doi):undefined,pmid:w.ids?.pmid?.split('/').filter(Boolean).at(-1),pmcid:w.ids?.pmcid?.split('/').filter(Boolean).at(-1),openalexId:w.id,abstract:invertedAbstract(w.abstract_inverted_index),url:w.primary_location?.landing_page_url??w.id,fullTextUrl:w.best_oa_location?.pdf_url??undefined,retracted:w.is_retracted===true,preprint:w.type==='preprint',identityVerified:false};}
function paperFromEpmc(w:any):Paper{const source=w.source??'MED';return {id:`epmc:${source}:${w.id}`,source:'europepmc',title:plainTitle(w.title??''),authors:arr(w.authorList?.author).map((a:any)=>a.fullName??`${a.lastName??''} ${a.firstName??''}`.trim()).filter(Boolean).length?arr(w.authorList?.author).map((a:any)=>a.fullName??`${a.lastName??''} ${a.firstName??''}`.trim()):(w.authorString??'').split(', ').filter(Boolean),year:Number(w.pubYear)||undefined,journal:w.journalInfo?.journal?.title,doi:w.doi?normalizeDoi(w.doi):undefined,pmid:source==='MED'?String(w.id):w.pmid,pmcid:w.pmcid,abstract:w.abstractText?clean(w.abstractText):undefined,url:`https://europepmc.org/article/${source}/${w.id}`,fullTextUrl:w.pmcid&&w.isOpenAccess==='Y'?`https://www.ebi.ac.uk/europepmc/webservices/rest/${w.pmcid}/fullTextXML`:undefined,retracted:w.isRetracted==='Y',preprint:source==='PPR',identityVerified:false};}
function paperFromCrossref(w:any):Paper {return {id:`doi:${normalizeDoi(w.DOI??'')}`,source:'crossref',title:plainTitle(clean(arr(w.title)[0])),authors:arr<any>(w.author).map(a=>[a.given,a.family].filter(Boolean).join(' ')),year:(w.published?.['date-parts']??w.issued?.['date-parts'])?.[0]?.[0],journal:clean(arr(w['container-title'])[0]),doi:normalizeDoi(w.DOI??''),url:w.URL,abstract:w.abstract?clean(new XMLParser().parse(`<a>${w.abstract}</a>`).a):undefined,preprint:w.type==='posted-content',identityVerified:false};}
function canonicalId(p:Paper):string {return p.doi?`doi:${normalizeDoi(p.doi)}`:p.pmid?`pmid:${p.pmid}`:p.pmcid?`pmcid:${p.pmcid}`:p.id;}
/** Only publication identity is merged. studyId is deliberately left to evidence extraction. */
export function dedupePapers(papers:Paper[]):Paper[]{
  const result:Paper[]=[];const index=new Map<string,number>();
  for(const p of papers){const keys=[p.doi?`doi:${normalizeDoi(p.doi)}`:'',p.pmid?`pmid:${p.pmid}`:'',p.pmcid?`pmcid:${p.pmcid}`:'',p.openalexId?`oa:${p.openalexId}`:'',`id:${p.id}`].filter(Boolean);const matches=[...new Set(keys.map(k=>index.get(k)).filter((v):v is number=>v!==undefined))];
    if(matches.length>1)throw new Error(`Conflicting publication identifiers for ${p.id}`);
    if(matches.length){const i=matches[0];const prev=result[i];if(prev.doi&&p.doi&&normalizeDoi(prev.doi)!==normalizeDoi(p.doi))throw new Error('Conflicting DOI values');result[i]={...p,...Object.fromEntries(Object.entries(prev).filter(([,v])=>v!==undefined)),abstract:prev.abstract||p.abstract,fullTextUrl:prev.fullTextUrl||p.fullTextUrl,identityVerified:prev.identityVerified||p.identityVerified,retracted:prev.retracted||p.retracted,correction:prev.correction||p.correction};for(const key of keys)index.set(key,i);}
    else{const i=result.length;result.push({...p,id:canonicalId(p),doi:p.doi?normalizeDoi(p.doi):undefined});for(const key of keys)index.set(key,i);}
  }
  return result;
}

export class LiteratureClient {
  private options:Required<Pick<LiteratureOptions,'timeoutMs'|'maxRecords'>> & LiteratureOptions;
  constructor(options:LiteratureOptions={}){this.options={timeoutMs:30000,maxRecords:500,...options};if(this.options.maxRecords<1||!Number.isInteger(this.options.maxRecords))throw new Error('maxRecords must be a positive integer');}
  private async get(url:string,signal?:AbortSignal):Promise<string>{const target=await assertLiteratureUrl(url,!this.options.skipDnsCheck);const skipWait=this.options.skipRateLimit??Boolean(this.options.fetchImpl);for(let attempt=0;attempt<3;attempt++){await this.options.beforeRequest?.();if(!skipWait)await rateLimit(target.hostname,signal);await this.options.beforeRequest?.();const response=await (this.options.fetchImpl??fetch)(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.options.timeoutMs)]):AbortSignal.timeout(this.options.timeoutMs),redirect:'error',headers:{'User-Agent':`PiLiteratureSystem/1.0${this.options.email?` (${this.options.email})`:''}`,'Accept':'application/json, application/xml, text/xml'}});if(!response.ok){if([429,503].includes(response.status)&&attempt<2){const retry=response.headers.get('Retry-After');const seconds=retry&&/^\d+$/.test(retry)?Number(retry):retry?(Date.parse(retry)-Date.now())/1000:undefined;const wait=Math.min(30_000,Math.max(0,Number.isFinite(seconds)?seconds!*1000:500*2**attempt));await response.body?.cancel();if(!skipWait)await delay(wait,signal);continue;}throw new Error(`Literature API returned HTTP ${response.status}`);}const content=await response.text();if(content.length>50_000_000)throw new Error('Literature response exceeds size limit');return content;}throw new Error('Literature API retry limit exceeded');}
  private async json(url:string,signal?:AbortSignal):Promise<any>{return JSON.parse(await this.get(url,signal));}
  async search(source:SourceName,query:string,cutoffDate:string,signal?:AbortSignal):Promise<SearchResult>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)||!Number.isFinite(Date.parse(cutoffDate)))throw new Error('Invalid cutoffDate');
    const log:SearchLog={id:uid('search_'),source,query,executedAt:now(),totalHits:0,returned:0,paginationComplete:false,cutoffDate};const papers:Paper[]=[];
    try{
      if(source==='pubmed'){
        const term=`(${query}) AND ("1800/01/01"[Date - Publication] : "${cutoffDate.replaceAll('-','/')}"[Date - Publication])`;let offset=0;
        do{const url=new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');url.search=new URLSearchParams({db:'pubmed',term,retmode:'json',retstart:String(offset),retmax:String(Math.min(200,this.options.maxRecords-papers.length)),sort:'relevance',...(this.options.email?{email:this.options.email}:{})}).toString();const data=await this.json(url.href,signal);if(data.error||data.esearchresult?.ERROR)throw new Error('PubMed rejected query');const x=data.esearchresult;if(!x)throw new Error('Missing PubMed search result');log.totalHits=Number(x.count);log.translatedQuery=x.querytranslation;const ids:string[]=x.idlist??[];if(!ids.length)break;
          const fetchUrl=new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi');fetchUrl.search=new URLSearchParams({db:'pubmed',id:ids.join(','),retmode:'xml'}).toString();papers.push(...parsePubmed(await this.get(fetchUrl.href,signal)));offset+=ids.length;
          if(offset>=9999){if(offset<log.totalHits)log.error='PubMed API search window reached; subdivide query by publication dates';break;}
        }while(papers.length<this.options.maxRecords&&offset<log.totalHits);
      }else if(source==='europepmc'){
        let cursor='*';const seen=new Set<string>();const term=`(${query}) AND FIRST_PDATE:[1800-01-01 TO ${cutoffDate}]`;log.translatedQuery=term;
        do{if(seen.has(cursor))throw new Error('Repeated Europe PMC cursor');seen.add(cursor);const url=new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');url.search=new URLSearchParams({query:term,format:'json',resultType:'core',pageSize:String(Math.min(1000,this.options.maxRecords-papers.length)),cursorMark:cursor}).toString();const data=await this.json(url.href,signal);log.totalHits=Number(data.hitCount??0);const page=data.resultList?.result??[];papers.push(...page.map(paperFromEpmc));const next=data.nextCursorMark;if(!page.length||!next||next===cursor)break;cursor=next;}while(papers.length<this.options.maxRecords&&papers.length<log.totalHits);
      }else if(source==='openalex'){
        let cursor='*';const seen=new Set<string>();
        do{if(seen.has(cursor))throw new Error('Repeated OpenAlex cursor');seen.add(cursor);const url=new URL('https://api.openalex.org/works');url.search=new URLSearchParams({search:query,filter:`to_publication_date:${cutoffDate}`,cursor,'per-page':String(Math.min(200,this.options.maxRecords-papers.length)),...(this.options.email?{mailto:this.options.email}:{})}).toString();const data=await this.json(url.href,signal);log.totalHits=Number(data.meta?.count??0);const page=data.results??[];papers.push(...page.map(paperFromOpenAlex));const next=data.meta?.next_cursor;if(!page.length||!next)break;cursor=next;}while(papers.length<this.options.maxRecords&&papers.length<log.totalHits);
      }else if(source==='crossref'){
        let cursor='*';const seen=new Set<string>();
        do{if(seen.has(cursor))throw new Error('Repeated Crossref cursor');seen.add(cursor);const url=new URL('https://api.crossref.org/works');url.search=new URLSearchParams({query,filter:`until-pub-date:${cutoffDate}`,cursor,rows:String(Math.min(1000,this.options.maxRecords-papers.length)),...(this.options.email?{mailto:this.options.email}:{})}).toString();const data=(await this.json(url.href,signal)).message;log.totalHits=Number(data?.['total-results']??0);const page=data?.items??[];papers.push(...page.map(paperFromCrossref));const next=data?.['next-cursor'];if(!page.length||!next||next===cursor)break;cursor=next;}while(papers.length<this.options.maxRecords&&papers.length<log.totalHits);
      }else throw new Error('Imported records are loaded from bibliography files');
      log.returned=papers.length;log.paginationComplete=Number.isFinite(log.totalHits)&&papers.length>=log.totalHits;
      if(!log.paginationComplete&&!log.error)log.error=papers.length>=this.options.maxRecords?'Record budget reached; search is incomplete':'Source ended pagination before reported total';
    }catch(e){if(signal?.aborted)throw e;log.error=e instanceof Error?e.message:String(e);log.returned=papers.length;}
    return {papers,log};
  }
  async fullText(paper:Paper,dataDir:string,signal?:AbortSignal):Promise<SourceDocument>{
    await mkdir(join(dataDir,'sources'),{recursive:true});
    if(paper.pmcid&&/^PMC\d+$/i.test(paper.pmcid)){
      try{const xml=await this.get(`https://www.ebi.ac.uk/europepmc/webservices/rest/${paper.pmcid.toUpperCase()}/fullTextXML`,signal);const hash=sha256(xml);const spans=parseJats(xml,paper.id,hash);if(!spans.some(s=>s.kind==='fulltext'))throw new Error('Full text XML has no body text');const path=join(dataDir,'sources',`${hash}.xml`);await immutableWrite(path,xml);return {paperId:paper.id,hash,format:'jats',path,acquiredAt:now(),spans,acquisition:'fulltext',parsing:'parsed',readSpanIds:[],visualVerified:false};}catch(e){if(signal?.aborted)throw e;}
    }
    const text=paper.abstract??'';const hash=sha256(text);const path=join(dataDir,'sources',`${hash}.txt`);await immutableWrite(path,text);return {paperId:paper.id,hash,format:'abstract',path,acquiredAt:now(),spans:text?[{id:`${paper.id}:abstract`,paperId:paper.id,sourceHash:hash,locator:'abstract',text,kind:'abstract'}]:[],acquisition:text?'abstract_only':'failed',parsing:text?'parsed':'failed',readSpanIds:[],visualVerified:false};
  }
  async references(paper:Paper,direction:'backward'|'forward',cutoffDate:string,signal?:AbortSignal):Promise<SearchResult>{
    if(paper.openalexId||paper.doi){
      const id=paper.openalexId?.split('/').at(-1)??`https://doi.org/${normalizeDoi(paper.doi!)}`;const target=await this.json(`https://api.openalex.org/works/${encodeURIComponent(id)}`,signal);
      if(direction==='forward')return this.openAlexFilter(`cites:${target.id.split('/').at(-1)},to_publication_date:${cutoffDate}`,cutoffDate,signal);
      const ids:string[]=target.referenced_works??[];const all:Paper[]=[];const count=Math.min(ids.length,this.options.maxRecords);
      for(let i=0;i<count;i+=40){const filter=`openalex_id:${ids.slice(i,Math.min(count,i+40)).map(x=>x.split('/').at(-1)).join('|')},to_publication_date:${cutoffDate}`;const result=await this.openAlexFilter(filter,cutoffDate,signal);all.push(...result.papers);}
      return {papers:all,log:{id:uid('citation_'),source:'openalex',query:`backward:${target.id}`,executedAt:now(),totalHits:ids.length,returned:all.length,paginationComplete:count===ids.length&&all.length===ids.length,cutoffDate,...(count<ids.length?{error:'Record budget reached; citation chase is incomplete'}:all.length<ids.length?{error:'Some references are outside cutoff or unavailable'}:{})}};
    }
    if(paper.pmid||paper.pmcid){const source=paper.pmid?'MED':'PMC';const id=paper.pmid??paper.pmcid!;const operation=direction==='backward'?'references':'citations';const out:Paper[]=[];let page=1,total=0;
      do{const url=new URL(`https://www.ebi.ac.uk/europepmc/webservices/rest/${source}/${id}/${operation}`);url.search=new URLSearchParams({format:'json',page:String(page),pageSize:String(Math.min(1000,this.options.maxRecords-out.length))}).toString();const data=await this.json(url.href,signal);total=Number(data.hitCount??0);const items=data[direction==='backward'?'referenceList':'citationList']?.[direction==='backward'?'reference':'citation']??[];out.push(...items.map((x:any)=>paperFromEpmc({...x,pubYear:x.pubYear??x.year})));if(!items.length)break;page++;}while(out.length<total&&out.length<this.options.maxRecords);
      const filtered=out.filter(p=>!p.year||p.year<=Number(cutoffDate.slice(0,4)));return {papers:filtered,log:{id:uid('citation_'),source:'europepmc',query:`${direction}:${source}:${id}`,executedAt:now(),totalHits:total,returned:filtered.length,paginationComplete:out.length>=total&&filtered.length===out.length,cutoffDate,...(out.length<total?{error:'Citation pagination incomplete'}:filtered.length<out.length?{error:'Citation date filtering is only exact to publication year'}:{})}};
    }
    return {papers:[],log:{id:uid('citation_'),source:paper.source,query:`${direction}:${paper.id}`,executedAt:now(),totalHits:0,returned:0,paginationComplete:false,cutoffDate,error:'No DOI, PMID, PMCID, or OpenAlex identifier available'}};
  }
  private async openAlexFilter(filter:string,cutoffDate:string,signal?:AbortSignal):Promise<SearchResult>{const papers:Paper[]=[];const log:SearchLog={id:uid('citation_'),source:'openalex',query:filter,executedAt:now(),totalHits:0,returned:0,paginationComplete:false,cutoffDate};let cursor='*';const seen=new Set<string>();do{if(seen.has(cursor))break;seen.add(cursor);const url=new URL('https://api.openalex.org/works');url.search=new URLSearchParams({filter,cursor,'per-page':String(Math.min(200,this.options.maxRecords-papers.length)),...(this.options.email?{mailto:this.options.email}:{})}).toString();const data=await this.json(url.href,signal);log.totalHits=data.meta.count;papers.push(...data.results.map(paperFromOpenAlex));if(!data.results.length||!data.meta.next_cursor)break;cursor=data.meta.next_cursor;}while(papers.length<log.totalHits&&papers.length<this.options.maxRecords);log.returned=papers.length;log.paginationComplete=papers.length>=log.totalHits;if(!log.paginationComplete)log.error='Citation pagination incomplete';return{papers,log};}
  async verifyPaper(paper:Paper,signal?:AbortSignal):Promise<Paper>{
    let authoritative:Paper|undefined;
    if(paper.doi){const data=(await this.json(`https://api.crossref.org/works/${encodeURIComponent(normalizeDoi(paper.doi))}`,signal)).message;authoritative=paperFromCrossref(data);if(normalizeDoi(authoritative.doi??'')!==normalizeDoi(paper.doi))throw new Error('DOI identity mismatch');
      // A notice's update-to describes the target, not a retraction of the notice itself.
      const updatesUrl=new URL('https://api.crossref.org/works');updatesUrl.search=new URLSearchParams({filter:`updates:${normalizeDoi(paper.doi)}`,rows:'100',...(this.options.email?{mailto:this.options.email}:{})}).toString();
      const updates=(await this.json(updatesUrl.href,signal)).message;const relationships=arr<any>(updates?.items).flatMap(w=>arr<any>(w['update-to'])).filter(x=>normalizeDoi(x.DOI??x.doi??'')===normalizeDoi(paper.doi!));
      authoritative.retracted=relationships.some(x=>x.type==='retraction');authoritative.correction=relationships.some(x=>['correction','erratum'].includes(x.type));
      if(Number(updates?.['total-results']??0)>100)throw new Error('Publication update history exceeds verification window');
    }
    else if(paper.pmid){const xml=await this.get(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${encodeURIComponent(paper.pmid)}&retmode=xml`,signal);authoritative=parsePubmed(xml).find(p=>p.pmid===paper.pmid);}
    else if(paper.openalexId){authoritative=paperFromOpenAlex(await this.json(`https://api.openalex.org/works/${encodeURIComponent(paper.openalexId.split('/').at(-1)!)}`,signal));}
    if(!authoritative)throw new Error('Unable to verify publication identity');
    const titleKey=(s:string)=>plainTitle(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
    if(paper.title&&titleKey(paper.title)!==titleKey(authoritative.title))throw new Error(`Title does not match verified identifier for ${paper.id}`);
    return {...paper,...Object.fromEntries(Object.entries(authoritative).filter(([,v])=>v!==undefined)),id:paper.id,source:paper.source,studyId:paper.studyId,pmid:paper.pmid??authoritative.pmid,pmcid:paper.pmcid??authoritative.pmcid,openalexId:paper.openalexId??authoritative.openalexId,abstract:paper.abstract??authoritative.abstract,retracted:paper.retracted||authoritative.retracted,correction:paper.correction||authoritative.correction,identityVerified:true};
  }
}
export async function immutableWrite(path:string,data:string|Uint8Array):Promise<void>{try{await writeFile(path,data,{flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
/** Bound model-tool reads without losing a source-relative locator or characters. */
export function splitSourceSpans(spans:SourceSpan[],limit=15000):SourceSpan[]{return spans.flatMap(span=>{if(span.text.length<=limit||span.kind==='image')return[span];const parts:SourceSpan[]=[];let start=0;while(start<span.text.length){let end=Math.min(start+limit,span.text.length);if(end<span.text.length){const newline=span.text.lastIndexOf('\n',end-1);const space=span.text.lastIndexOf(' ',end-1);const boundary=Math.max(newline,space);if(boundary>start+Math.floor(limit/2))end=boundary+1;}parts.push({...span,id:`${span.id}:part${parts.length+1}`,locator:`${span.locator}; characters ${start+1}-${end}`,text:span.text.slice(start,end)});start=end;}return parts;});}
function safeXml(xml:string):void{if(/<!ENTITY/i.test(xml))throw new Error('XML entity declarations are forbidden');const check=XMLValidator.validate(xml);if(check!==true)throw new Error(`Invalid source XML: ${check.err.msg}`);}
export function parsePubmed(xml:string):Paper[]{safeXml(xml);const parsed=new XMLParser({ignoreAttributes:false}).parse(xml);return arr<any>(parsed.PubmedArticleSet?.PubmedArticle).map(a=>{const m=a.MedlineCitation??{};const x=m.Article??{};const ids=arr<any>(a.PubmedData?.ArticleIdList?.ArticleId);const id=(type:string)=>clean(ids.find(z=>z['@_IdType']===type));const types=arr<any>(x.PublicationTypeList?.PublicationType).map(clean);return {id:`pmid:${clean(m.PMID)}`,source:'pubmed' as const,title:clean(x.ArticleTitle),authors:arr<any>(x.AuthorList?.Author).map(z=>[clean(z.ForeName),clean(z.LastName)].filter(Boolean).join(' ')||clean(z.CollectiveName)),year:Number(clean(x.Journal?.JournalIssue?.PubDate?.Year))||Number(clean(x.Journal?.JournalIssue?.PubDate?.MedlineDate).match(/\d{4}/)?.[0])||undefined,journal:clean(x.Journal?.Title),doi:id('doi')?normalizeDoi(id('doi')):undefined,pmid:clean(m.PMID),pmcid:id('pmc')||undefined,abstract:arr<any>(x.Abstract?.AbstractText).map(z=>typeof z==='object'&&z['@_Label']?`${z['@_Label']}: ${clean(z)}`:clean(z)).join('\n')||undefined,url:`https://pubmed.ncbi.nlm.nih.gov/${clean(m.PMID)}/`,retracted:types.includes('Retracted Publication'),correction:types.includes('Published Erratum'),identityVerified:false};});}
export function parseJats(xml:string,paperId:string,hash=sha256(xml)):SourceSpan[]{
  safeXml(xml);const tree=new XMLParser({ignoreAttributes:false,preserveOrder:true,processEntities:true,trimValues:false}).parse(xml);const spans:SourceSpan[]=[];let counter=0;
  const rawText=(nodes:any[]):string=>nodes.map(n=>Object.entries(n).filter(([k])=>k!==':@').map(([k,v])=>{if(k==='#text')return String(v);if(!Array.isArray(v))return '';const value=rawText(v);return /^(p|title|caption|label|tr|list-item)$/.test(k)?`\n${value}\n`:/^(td|th)$/.test(k)?`${value}\t`:value;}).join('')).join('');
  const text=(nodes:any[]):string=>rawText(nodes).replace(/[^\S\n\t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  const walk=(nodes:any[],path:string,inBody:boolean,section:string)=>{for(const node of nodes){for(const [tag,value]of Object.entries(node)){if(tag===':@'||tag==='#text'||!Array.isArray(value))continue;const attrs=node[':@']??{};const current=`${path}/${tag}${attrs['@_id']?`#${attrs['@_id']}`:''}`;const body=inBody||tag==='body';let label=section;if(tag==='sec'){const title=value.find((n:any)=>n.title);if(title)label=text(title.title);}
      const kind:SourceSpan['kind']|undefined=tag==='abstract'?'abstract':tag==='table-wrap'?'table':tag==='fig'?'figure_caption':tag==='p'&&body?'fulltext':undefined;
      if(kind){const content=text(value);if(content)spans.push({id:`${paperId}:s${++counter}`,paperId,sourceHash:hash,locator:`${current}${label?` (${label})`:''}`,text:content,kind});if(tag!=='p')continue;}
      walk(value,current,body,label);
    }}};walk(tree,'',false,'');return splitSourceSpans(spans);
}

import {readFile, mkdir, copyFile} from 'node:fs/promises';
import {join, resolve, extname, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Paper, SourceDocument, SourceSpan} from '../shared/types.ts';
import {now, sha256} from '../shared/util.ts';
import {dedupePapers, normalizeDoi,splitSourceSpans} from './sources.ts';

const exec=promisify(execFile);
export async function importBibliography(path:string):Promise<Paper[]>{
  const text=(await readFile(path,'utf8')).replace(/^\uFEFF/,'');
  if(text.length>20_000_000)throw new Error('Bibliography exceeds size limit');
  const ext=extname(path).toLowerCase();let papers:Paper[];
  if(ext==='.ris')papers=parseRis(text);
  else if(ext==='.bib'||ext==='.bibtex'){
    const require=createRequire(import.meta.url);const {Cite}=require('@citation-js/core');require('@citation-js/plugin-bibtex');
    let items:any[];try{items=new Cite(text).data;}catch(e){throw new Error(`Invalid BibTeX: ${e instanceof Error?e.message:String(e)}`);}
    if(!items.length)throw new Error('Bibliography contains no records');
    papers=items.map((x:any,i:number)=>{if(!x.title)throw new Error(`BibTeX record ${i+1} has no title`);return {id:`import:${sha256(JSON.stringify(x)).slice(0,20)}`,source:'import' as const,title:String(x.title),authors:(x.author??[]).map((a:any)=>a.literal??[a.given,a.family].filter(Boolean).join(' ')),year:x.issued?.['date-parts']?.[0]?.[0],journal:x['container-title'],doi:x.DOI?normalizeDoi(x.DOI):undefined,abstract:x.abstract,url:x.URL,identityVerified:false};});
  }else throw new Error('Supported bibliography extensions are .ris, .bib and .bibtex');
  return dedupePapers(papers);
}
export function parseRis(text:string):Paper[]{
  const records:Record<string,string[]>[]=[];let current:Record<string,string[]>|undefined;let previous='';
  for(const line of text.split(/\r?\n/)){if(!line.trim())continue;const match=/^([A-Z0-9]{2})\s{2}-\s?(.*)$/.exec(line);
    if(match){const [,key,value]=match;if(key==='TY'){if(current)throw new Error('RIS record missing ER terminator');current={TY:[value]};}
      else if(key==='ER'){if(!current)throw new Error('RIS ER without a record');records.push(current);current=undefined;}
      else{if(!current)throw new Error('RIS tag outside a record');(current[key]??=[]).push(value);}previous=key;
    }else{if(!current||!previous||previous==='TY'||previous==='ER')throw new Error('Malformed RIS line');const values=current[previous];values[values.length-1]+=`\n${line.trim()}`;}
  }
  if(current)throw new Error('RIS record missing ER terminator');if(!records.length)throw new Error('Bibliography contains no RIS records');
  return records.map((r,i)=>{const one=(...keys:string[])=>keys.map(k=>r[k]?.[0]).find(Boolean);const title=one('TI','T1','CT');if(!title)throw new Error(`RIS record ${i+1} has no title`);const pmid=one('AN')?.match(/^(?:PMID\s*:?\s*)?(\d+)$/i)?.[1];return {id:`import:${sha256(JSON.stringify(r)).slice(0,20)}`,source:'import',title,authors:r.AU??r.A1??[],year:Number(one('PY','Y1')?.match(/\d{4}/)?.[0])||undefined,journal:one('JO','JF','T2'),doi:one('DO')?normalizeDoi(one('DO')!):undefined,pmid,abstract:one('AB','N2'),url:one('UR'),preprint:r.TY?.[0]==='UNPB',identityVerified:false};});
}
export async function importPdf(path:string,paper:Paper,dataDir:string,pythonPath?:string):Promise<SourceDocument>{
  if(!pythonPath)throw new Error('PDF import requires a configured Python runtime with pdfplumber and pypdfium2');
  const bytes=await readFile(path);if(bytes.length>250_000_000)throw new Error('PDF exceeds 250 MB size limit');if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('File does not have a PDF header');
  const hash=sha256(bytes);const folder=join(dataDir,'sources',hash);await mkdir(folder,{recursive:true});const immutablePath=join(folder,'source.pdf');
  try{await copyFile(path,immutablePath,1);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const helper=resolve(dirname(fileURLToPath(import.meta.url)),'../../scripts/pdf_extract.py');
  const {stdout}=await exec(pythonPath,[helper,immutablePath,folder],{timeout:180000,maxBuffer:30_000_000,windowsHide:true});
  const parsed=JSON.parse(stdout) as {pages:{page:number;text:string;image:string}[];warnings:string[]};
  const spans:SourceSpan[]=[];for(const page of parsed.pages){if(page.text.trim())spans.push({id:`${paper.id}:p${page.page}:text`,paperId:paper.id,sourceHash:hash,locator:`PDF page ${page.page}`,page:page.page,text:page.text,kind:'fulltext'});spans.push({id:`${paper.id}:p${page.page}:image`,paperId:paper.id,sourceHash:hash,locator:`PDF page ${page.page} rendered image`,page:page.page,text:'Page image; must be viewed before making image-dependent claims',kind:'image',imagePath:page.image});}
  return {paperId:paper.id,hash,format:'pdf',path:immutablePath,acquiredAt:now(),spans:splitSourceSpans(spans),acquisition:'fulltext',parsing:spans.some(s=>s.kind==='fulltext')?'parsed':'failed',readSpanIds:[],visualVerified:false};
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {buildServer} from '../src/cloud/server.js';
import {ResearchApi,confirmedCommandText,currentRoleEvents} from '../web/src/api.js';
import type {ResearchBundle,RunRecord,RunSpec} from '../src/shared/types.js';

test('real HTTP console flow holds uploads before start, confirms control, and reads committed owner-only reports',async()=>{
  const root=resolve(process.cwd(),'work/web-api-tests');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'flow-'));
  const server=await buildServer({dataDir:dir,host:'127.0.0.1',devAuth:true,devOwnerId:'web-api-engineering',webUrl:'http://127.0.0.1:5173/'});
  try{
    await server.listen({host:'127.0.0.1',port:0});const address=server.server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
    const session=await new ResearchApi(url,null).devLogin();const api=new ResearchApi(url,session.token);const pair=await api.pair('Engineering API fixture');
    const worker=async<T=any>(path:string,body:unknown)=>{const response=await fetch(url+path,{method:'POST',headers:{Authorization:'Bearer '+pair.workerToken,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,path);return response.json() as Promise<T>;};
    const spec:RunSpec={topic:'工程 API 验收，无模型调用',sources:['import'],cutoffDate:'2026-10-13',language:'zh',modelProfile:'unused',budget:{maxTokens:1,maxRequests:1,maxMinutes:1},scopeVersion:1,maxRepairRounds:0};
    const {run}=await api.create(spec,true);assert.equal(run.status,'draft');assert.equal((await worker('/worker/claim',{})).run,null);
    const upload=await api.upload(run.id,new File(['TY  - JOUR\nTI  - ENGINEERING ONLY\nER  -\n'],'fixture.ris'));assert.ok(upload.id);assert.equal((await worker('/worker/claim',{})).run,null);
    await api.start(run.id);const claimed=await worker<{run:RunRecord}>('/worker/claim',{});assert.equal(claimed.run.id,run.id);
    const {command,run:requested}=await api.command(run.id,'pause');assert.equal(requested.status,'pause_requested');assert.equal(command.status,'requested');
    const read=await api.detail(run.id);assert.equal(read.commands[0].status,'requested');assert.equal(read.manifest,null);assert.equal(read.uploads[0].received,false);
    await worker(`/worker/runs/${run.id}/commands/${command.id}/ack`,{epoch:claimed.run.epoch,status:'received'});
    await worker(`/worker/runs/${run.id}/commands/${command.id}/ack`,{epoch:claimed.run.epoch,status:'applied'});
    const paused=await api.detail(run.id);assert.equal(paused.run.status,'paused');assert.equal(confirmedCommandText(paused.commands[0],paused.run.epoch),'执行端已确认');
    await api.command(run.id,'resume');const resumed=await worker<{run:RunRecord}>('/worker/claim',{});assert.equal(resumed.run.epoch,2);
    const event={runId:run.id,epoch:2,seq:1,type:'agent_end',timestamp:new Date().toISOString(),data:{role:'auditor',fixture:true}};
    await worker(`/worker/runs/${run.id}/events`,{epoch:2,events:[event]});
    const bundle:ResearchBundle={runId:run.id,spec,scope:{interpretation:'工程接口验收，不包含科学结果',questions:[],inclusion:[],exclusion:[],assumptions:[]},papers:[],searches:[],screening:[],documents:[],evidence:[],claims:[],paradigms:[],sections:[{title:'工程验收',paragraphs:[{text:'仅测试API，0模型调用。',claimIds:[]}]}],findings:[],gaps:['未开展科学验收'],status:'completed_with_gaps',usage:{requests:0,tokens:0,costUsd:0,unknownRequests:0},coverage:[]};
    const bytes=Buffer.from(JSON.stringify(bundle));const hash=createHash('sha256').update(bytes).digest('hex');
    const put=await fetch(`${url}/worker/runs/${run.id}/artifacts/1/bundle.json`,{method:'POST',headers:{Authorization:'Bearer '+pair.workerToken,'Content-Type':'application/octet-stream','x-run-epoch':'2','x-artifact-mime':'application/json'},body:bytes});assert.equal(put.status,200);
    const path=`/api/runs/${run.id}/artifacts/1/bundle.json`;assert.equal((await fetch(url+path,{headers:{Authorization:'Bearer '+session.token}})).status,404);
    await worker(`/worker/runs/${run.id}/complete`,{epoch:2,status:bundle.status,gaps:bundle.gaps,manifest:{version:1,files:[{name:'bundle.json',mime:'application/json',sha256:hash,size:bytes.length}]}});
    const completed=await api.detail(run.id);assert.equal(completed.run.status,'completed_with_gaps');assert.equal(completed.bundle?.sections[0].title,'工程验收');assert.equal(currentRoleEvents(completed.events,2).auditor.type,'agent_end');
    assert.equal((await fetch(url+path)).status,401);const ownerDownload=await fetch(url+path,{headers:{Authorization:'Bearer '+session.token}});assert.equal(ownerDownload.status,200);assert.deepEqual(Buffer.from(await ownerDownload.arrayBuffer()),bytes);
  }finally{await server.close();const target=resolve(dir);assert.ok(target.startsWith(root+sep));rmSync(target,{recursive:true,force:true});}
});

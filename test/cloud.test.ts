import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {buildServer} from '../src/cloud/server.js';
import {sha256} from '../src/shared/util.js';
import type {RunSpec} from '../src/shared/types.js';
import {CloudClient} from '../src/worker/main.ts';

const spec:RunSpec={topic:'测试主题',sources:['pubmed','europepmc'],cutoffDate:'2026-10-13',language:'zh',modelProfile:'strong',budget:{maxTokens:10000,maxRequests:20,maxMinutes:30},scopeVersion:1,maxRepairRounds:3};
const scratchRoot=resolve(process.cwd(),'work','cloud-tests');
mkdirSync(scratchRoot,{recursive:true});
function removeScratch(dir:string){const target=resolve(dir);assert.ok(target.startsWith(scratchRoot+sep));rmSync(target,{recursive:true,force:true});}
async function setup(){
  // Test scratch data follows the workspace; no credentials or historical systems are involved.
  const dir=mkdtempSync(join(scratchRoot,'test-'));
  let time=Date.parse('2026-10-13T00:00:00Z');
  const app=await buildServer({dataDir:dir,devAuth:true,devOwnerId:'alice',leaseMs:1000,clock:()=>time,workers:[{id:'worker-a',token:'worker-token-alice-long-value',ownerId:'alice'},{id:'worker-b',token:'worker-token-bob-long-value',ownerId:'bob'},{id:'worker-c',token:'worker-token-alice-second-worker',ownerId:'alice'}]});
  const login=await app.inject({method:'POST',url:'/auth/dev'}),auth={authorization:`Bearer ${login.json().token}`},worker={authorization:'Bearer worker-token-alice-long-value'},otherWorker={authorization:'Bearer worker-token-bob-long-value'};
  const created=await app.inject({method:'POST',url:'/api/runs',headers:auth,payload:spec});assert.equal(created.statusCode,200);const run=created.json().run;
  return {app,auth,worker,otherWorker,run,advance:(n:number)=>{time+=n;},close:async()=>{await app.close();removeScratch(dir);}};
}

test('worker HTTP client claims and reads status through the actual JSON parser',async()=>{
  const s=await setup();const env='PI_LITERATURE_TEST_WORKER_TOKEN';const previous=process.env[env];process.env[env]='worker-token-alice-long-value';
  try{const url=await s.app.listen({host:'127.0.0.1',port:0});const client=new CloudClient({cloudUrl:url,workerId:'worker-a',workerTokenEnv:env} as any);const claimed=await client.call('/worker/claim');assert.equal(claimed.run.id,s.run.id);const status=await client.call(`/worker/runs/${s.run.id}/status`,'GET');assert.equal(status.status,'running');assert.equal(status.epoch,1);}
  finally{if(previous===undefined)delete process.env[env];else process.env[env]=previous;await s.close();}
});
test('browser and worker credentials are distinct; ownership and unauthenticated downloads are enforced',async()=>{
  const s=await setup();try{
    assert.equal((await s.app.inject({method:'GET',url:'/api/runs',headers:s.worker})).statusCode,401);
    assert.equal((await s.app.inject({method:'POST',url:'/worker/claim',headers:s.auth})).statusCode,401);
    const claim=await s.app.inject({method:'POST',url:'/worker/claim',headers:s.otherWorker});assert.equal(claim.json().run,null);
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/heartbeat`,headers:s.otherWorker,payload:{epoch:1}})).statusCode,404);
    assert.equal((await s.app.inject({method:'GET',url:`/api/runs/${s.run.id}/artifacts/1/report.html`})).statusCode,401);
    assert.equal((await s.app.inject({method:'GET',url:`/api/runs/${s.run.id}`,headers:s.auth})).statusCode,200);
  }finally{await s.close();}
});
test('leases expire without implicit rerun; explicit recovery fences stale epochs',async()=>{
  const s=await setup();try{
    const claimed=(await s.app.inject({method:'POST',url:'/worker/claim',headers:s.worker})).json().run;assert.equal(claimed.epoch,1);
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/checkpoint`,headers:s.worker,payload:{epoch:1,checkpoint:{phase:'extract',scopeVersion:1,localCheckpointHash:sha256('unknown request preserved locally'),localState:true,workerId:'worker-a',lastEventSeq:0}}})).statusCode,200);
    s.advance(1001);
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/heartbeat`,headers:s.worker,payload:{epoch:1}})).statusCode,409);
    assert.equal((await s.app.inject({method:'POST',url:'/worker/claim',headers:s.worker})).json().run,null);
    assert.equal((await s.app.inject({method:'GET',url:`/api/runs/${s.run.id}`,headers:s.auth})).json().run.status,'waiting_worker');
    const recovered=await s.app.inject({method:'POST',url:'/worker/recover',headers:s.worker,payload:{runId:s.run.id,previousEpoch:1}});assert.equal(recovered.statusCode,200);assert.equal(recovered.json().run.epoch,2);assert.equal(recovered.json().checkpoint.phase,'extract');
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/checkpoint`,headers:s.worker,payload:{epoch:1,checkpoint:{}}})).statusCode,409);
  }finally{await s.close();}
});
test('event batches are monotonic, idempotent, and atomic on invalid gaps',async()=>{
  const s=await setup();try{
    await s.app.inject({method:'POST',url:'/worker/claim',headers:s.worker});
    const event={runId:s.run.id,epoch:1,seq:1,type:'started',timestamp:'2026-10-13T00:00:00Z',data:{phase:'search'}};
    for(let i=0;i<2;i++)assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/events`,headers:s.worker,payload:{epoch:1,events:[event]}})).statusCode,200);
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/events`,headers:s.worker,payload:{epoch:1,events:[{...event,data:{phase:'different'}}]}})).statusCode,409);
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/events`,headers:s.worker,payload:{epoch:1,events:[{...event,seq:2},{...event,seq:4}]}})).statusCode,409);
    const events=(await s.app.inject({method:'GET',url:`/api/runs/${s.run.id}/events`,headers:s.auth})).json().events;assert.equal(events.length,1);assert.equal(events[0].seq,1);
  }finally{await s.close();}
});
test('pause remains requested until worker acknowledges; scope applies only at acknowledgement',async()=>{
  const s=await setup();try{
    await s.app.inject({method:'POST',url:'/worker/claim',headers:s.worker});
    const scoped=(await s.app.inject({method:'POST',url:`/api/runs/${s.run.id}/commands`,headers:s.auth,payload:{kind:'scope',payload:{focus:'机制验证'}}})).json();
    assert.equal(scoped.run.spec.focus,undefined);
    await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/commands/${scoped.command.id}/ack`,headers:s.worker,payload:{epoch:1,status:'applied'}});
    const updated=(await s.app.inject({method:'GET',url:`/api/runs/${s.run.id}`,headers:s.auth})).json().run;assert.equal(updated.spec.focus,'机制验证');assert.equal(updated.spec.scopeVersion,2);
    const pause=(await s.app.inject({method:'POST',url:`/api/runs/${s.run.id}/commands`,headers:s.auth,payload:{kind:'pause'}})).json();assert.equal(pause.run.status,'pause_requested');assert.equal(pause.command.status,'requested');
    const heart=(await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/heartbeat`,headers:s.worker,payload:{epoch:1,phase:'extract'}})).json();assert.equal(heart.commands.length,1);
    const ack=await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/commands/${pause.command.id}/ack`,headers:s.worker,payload:{epoch:1,status:'applied'}});assert.equal(ack.json().run.status,'paused');assert.equal(ack.json().run.leaseUntil,null);
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/heartbeat`,headers:s.worker,payload:{epoch:1}})).statusCode,409);
    await s.app.inject({method:'POST',url:`/api/runs/${s.run.id}/commands`,headers:s.auth,payload:{kind:'resume'}});
    assert.equal((await s.app.inject({method:'POST',url:'/worker/claim',headers:s.worker})).json().run.epoch,2);
  }finally{await s.close();}
});
test('completion validates manifest and only committed immutable artifacts can be downloaded',async()=>{
  const s=await setup();try{
    await s.app.inject({method:'POST',url:'/worker/claim',headers:s.worker});
    const bytes=Buffer.from('<html>核验报告</html>');
    const uploaded=await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/artifacts/1/report.html`,headers:{...s.worker,'content-type':'application/octet-stream','x-run-epoch':'1','x-artifact-mime':'text/html'},payload:bytes});assert.equal(uploaded.statusCode,200);
    assert.equal((await s.app.inject({method:'GET',url:`/api/runs/${s.run.id}/artifacts/1/report.html`,headers:s.auth})).statusCode,404);
    const manifest={version:1,files:[{name:'report.html',mime:'text/html',sha256:sha256(bytes),size:bytes.length}]};
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/complete`,headers:s.worker,payload:{epoch:1,status:'completed',manifest:{...manifest,files:[{...manifest.files[0],sha256:'0'.repeat(64)}]}}})).statusCode,409);
    const complete=await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/complete`,headers:s.worker,payload:{epoch:1,status:'completed_with_gaps',manifest,gaps:['全文不可获取']}});assert.equal(complete.statusCode,200);assert.equal(complete.json().run.status,'completed_with_gaps');
    const download=await s.app.inject({method:'GET',url:`/api/runs/${s.run.id}/artifacts/1/report.html`,headers:s.auth});assert.equal(download.statusCode,200);assert.deepEqual(download.rawPayload,bytes);
    assert.equal((await s.app.inject({method:'GET',url:`/api/runs/${s.run.id}/artifacts/1/report.html`,headers:s.otherWorker})).statusCode,401);
  }finally{await s.close();}
});
test('development authentication cannot bind a public interface',async()=>{
  await assert.rejects(()=>buildServer({dataDir:'unused',host:'0.0.0.0',devAuth:true}),/loopback/);
});
test('private checkpoints reject document content; resumed local-state tasks remain pinned to their worker',async()=>{
  const s=await setup();try{
    await s.app.inject({method:'POST',url:'/worker/claim',headers:s.worker});
    const checkpoint={phase:'synthesis',scopeVersion:1,localCheckpointHash:sha256('local checkpoint'),localState:true,workerId:'worker-a',lastEventSeq:0};
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/checkpoint`,headers:s.worker,payload:{epoch:1,checkpoint:{...checkpoint,documents:[{path:'private',text:'full article'}]}}})).statusCode,400);
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/checkpoint`,headers:s.worker,payload:{epoch:1,checkpoint}})).statusCode,200);
    const scope=(await s.app.inject({method:'POST',url:`/api/runs/${s.run.id}/commands`,headers:s.auth,payload:{kind:'scope',payload:{focus:'新范围'}}})).json().command;
    const ack=await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/commands/${scope.id}/ack`,headers:s.worker,payload:{epoch:1,status:'applied',pauseAfterApply:true}});assert.equal(ack.json().run.status,'paused');assert.equal(ack.json().run.spec.scopeVersion,2);
    await s.app.inject({method:'POST',url:`/api/runs/${s.run.id}/commands`,headers:s.auth,payload:{kind:'resume'}});
    const elsewhere=await s.app.inject({method:'POST',url:'/worker/claim',headers:{authorization:'Bearer worker-token-alice-second-worker'}});assert.equal(elsewhere.json().run,null);
    const resumed=await s.app.inject({method:'POST',url:'/worker/claim',headers:s.worker});assert.equal(resumed.json().run.epoch,2);assert.equal(resumed.json().checkpoint.workerId,'worker-a');
  }finally{await s.close();}
});
test('control requests are idempotent and cancellation takes priority; failures release their lease',async()=>{
  const s=await setup();try{
    await s.app.inject({method:'POST',url:'/worker/claim',headers:s.worker});
    const first=await s.app.inject({method:'POST',url:`/api/runs/${s.run.id}/commands`,headers:s.auth,payload:{kind:'pause'}});
    const duplicate=await s.app.inject({method:'POST',url:`/api/runs/${s.run.id}/commands`,headers:s.auth,payload:{kind:'pause'}});assert.equal(first.json().command.id,duplicate.json().command.id);
    await s.app.inject({method:'POST',url:`/api/runs/${s.run.id}/commands`,headers:s.auth,payload:{kind:'cancel'}});
    const heartbeat=(await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/heartbeat`,headers:s.worker,payload:{epoch:1}})).json();assert.equal(heartbeat.commands[0].kind,'cancel');
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/commands/${first.json().command.id}/ack`,headers:s.worker,payload:{epoch:1,status:'applied'}})).statusCode,409);
    const failed=await s.app.inject({method:'POST',url:`/worker/runs/${s.run.id}/fail`,headers:s.worker,payload:{epoch:1,error:'模型连接失败，检查点已保存'}});assert.equal(failed.statusCode,200);assert.equal(failed.json().run.status,'failed');assert.equal(failed.json().run.leaseUntil,null);
  }finally{await s.close();}
});
test('draft tasks cannot be claimed before upload/start; active runs reject uploads and status leaks no content',async()=>{
  const s=await setup();try{
    // Cancel the queued setup task so the draft is the only candidate.
    await s.app.inject({method:'POST',url:`/api/runs/${s.run.id}/commands`,headers:s.auth,payload:{kind:'cancel'}});
    const created=await s.app.inject({method:'POST',url:'/api/runs',headers:s.auth,payload:{...spec,deferStart:true}});assert.equal(created.json().run.status,'draft');const id=created.json().run.id;
    assert.equal((await s.app.inject({method:'POST',url:'/worker/claim',headers:s.worker})).json().run,null);
    const boundary='pi-test-boundary';const file=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference.ris"\r\nContent-Type: application/x-research-info-systems\r\n\r\nTY  - JOUR\r\nTI  - Imported study\r\nER  -\r\n--${boundary}--\r\n`);
    const upload=await s.app.inject({method:'POST',url:`/api/runs/${id}/uploads`,headers:{...s.auth,'content-type':`multipart/form-data; boundary=${boundary}`},payload:file});assert.equal(upload.statusCode,200);assert.ok(upload.json().upload.sha256);
    for(let i=0;i<2;i++)assert.equal((await s.app.inject({method:'POST',url:`/api/runs/${id}/start`,headers:s.auth})).json().run.status,'queued');
    const claimed=(await s.app.inject({method:'POST',url:'/worker/claim',headers:s.worker})).json().run;assert.equal(claimed.id,id);
    assert.equal((await s.app.inject({method:'POST',url:`/api/runs/${id}/uploads`,headers:{...s.auth,'content-type':`multipart/form-data; boundary=${boundary}`},payload:file})).statusCode,409);
    const status=await s.app.inject({method:'GET',url:`/worker/runs/${id}/status`,headers:s.worker});assert.equal(status.statusCode,200);assert.deepEqual(Object.keys(status.json()).sort(),['epoch','leaseUntil','status','workerId']);
    assert.equal((await s.app.inject({method:'GET',url:`/worker/runs/${id}/status`,headers:s.otherWorker})).statusCode,404);
    const remote=(await s.app.inject({method:'GET',url:`/worker/runs/${id}/uploads?epoch=1`,headers:s.worker})).json().uploads[0];
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${id}/uploads/${remote.id}/received`,headers:s.worker,payload:{epoch:1,sha256:'0'.repeat(64)}})).statusCode,409);
    assert.equal((await s.app.inject({method:'POST',url:`/worker/runs/${id}/uploads/${remote.id}/received`,headers:s.worker,payload:{epoch:1,sha256:remote.sha256}})).statusCode,200);
    assert.equal((await s.app.inject({method:'GET',url:`/worker/runs/${id}/uploads/${remote.id}?epoch=1`,headers:s.worker})).statusCode,404);
  }finally{await s.close();}
});
test('OAuth validates state, allowlist and single-use ticket with mocked GitHub responses',async()=>{
  const dir=mkdtempSync(join(scratchRoot,'oauth-'));let githubUser={id:123,login:'Alice'};
  const app=await buildServer({dataDir:dir,publicUrl:'https://api.example.test/literature/api',webUrl:'https://owner.github.io/research/',githubClientId:'mock-client',githubClientSecret:'mock-secret',allowGithubLogins:['Alice','Bob'],fetch:async(url,options)=>{const exchanging=String(url).includes('/access_token');if(exchanging)assert.equal(typeof JSON.parse(String(options?.body)).code_verifier,'string');return new Response(JSON.stringify(exchanging?{access_token:'never-downloaded-to-browser'}:githubUser),{status:200,headers:{'content-type':'application/json'}});}});
  try{
    const start=await app.inject({method:'GET',url:'/auth/github/start'});assert.equal(start.statusCode,302);const authorization=new URL(start.headers.location!);assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');assert.match(String(start.headers['set-cookie']),/Path=\/literature\/api\/auth/);const state=authorization.searchParams.get('state');const cookie=String(start.headers['set-cookie']).split(';')[0];
    assert.equal((await app.inject({method:'GET',url:`/auth/github/callback?code=code&state=${state}`})).statusCode,400);
    const callback=await app.inject({method:'GET',url:`/auth/github/callback?code=code&state=${state}`,headers:{cookie}});assert.equal(callback.statusCode,302);assert.ok(!callback.headers.location!.includes('never-downloaded'));
    const ticket=new URLSearchParams(new URL(callback.headers.location!).hash.slice(1)).get('ticket');const redeem=await app.inject({method:'POST',url:'/auth/ticket',payload:{ticket}});assert.equal(redeem.statusCode,200);assert.equal(redeem.json().ownerId,'github:123');assert.equal(redeem.json().user.login,'alice');assert.equal((await app.inject({method:'POST',url:'/auth/ticket',payload:{ticket}})).statusCode,401);
    const aliceHeaders={authorization:`Bearer ${redeem.json().token}`};const run=(await app.inject({method:'POST',url:'/api/runs',headers:aliceHeaders,payload:spec})).json().run;
    githubUser={id:456,login:'Bob'};
    const bobStart=await app.inject({method:'GET',url:'/auth/github/start'});const bobState=new URL(bobStart.headers.location!).searchParams.get('state');const bobCookie=String(bobStart.headers['set-cookie']).split(';')[0];
    const bobCallback=await app.inject({method:'GET',url:`/auth/github/callback?code=code&state=${bobState}`,headers:{cookie:bobCookie}});const bobTicket=new URLSearchParams(new URL(bobCallback.headers.location!).hash.slice(1)).get('ticket');const bobSession=(await app.inject({method:'POST',url:'/auth/ticket',payload:{ticket:bobTicket}})).json();
    assert.equal((await app.inject({method:'GET',url:`/api/runs/${run.id}`,headers:{authorization:`Bearer ${bobSession.token}`}})).statusCode,404);
    assert.equal((await app.inject({method:'GET',url:`/api/runs/${run.id}/events`,headers:{authorization:`Bearer ${bobSession.token}`}})).statusCode,404);
    githubUser={id:789,login:'Alice'};
    const takeoverStart=await app.inject({method:'GET',url:'/auth/github/start'});const takeoverState=new URL(takeoverStart.headers.location!).searchParams.get('state');const takeoverCookie=String(takeoverStart.headers['set-cookie']).split(';')[0];
    assert.equal((await app.inject({method:'GET',url:`/auth/github/callback?code=code&state=${takeoverState}`,headers:{cookie:takeoverCookie}})).statusCode,403);
  }finally{await app.close();removeScratch(dir);}
});

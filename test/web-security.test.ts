import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResearchApi, confirmedCommandText, currentRoleEvents, mergeEvents, reportedCost, safeExternalUrl, ticketFromFragment, validateApiUrl } from '../web/src/api.js';
import type { Command, RunEvent } from '../src/shared/types.js';

test('service URLs allow HTTPS and explicit local development without embedded credentials', () => {
  assert.equal(validateApiUrl(' https://research.example.org/ '), 'https://research.example.org');
  assert.equal(validateApiUrl('http://localhost:8787', true), 'http://localhost:8787');
  for (const url of ['http://research.example.org','http://localhost:8787','https://user:secret@example.org','https://example.org/?token=secret','https://example.org/#secret','javascript:alert(1)']) assert.throws(()=>validateApiUrl(url));
});
test('OAuth ticket is read from a fragment and bounded', () => {
  assert.equal(ticketFromFragment('#ticket=one-time&unused=x'),'one-time');
  assert.equal(ticketFromFragment('#token=secret'),null);
  assert.equal(ticketFromFragment(`#ticket=${'x'.repeat(4097)}`),null);
});
test('late and duplicate events do not overwrite current execution activity', () => {
  const event=(epoch:number,seq:number,role:string,type='agent_start'):RunEvent=>({runId:'r',epoch,seq,type,timestamp:'2026-10-13T00:00:00Z',data:{role}});
  const events=mergeEvents([event(1,1,'researcher'),event(2,1,'analyst')],[event(1,1,'researcher'),event(1,2,'auditor'),event(2,2,'analyst','agent_end')]);
  assert.equal(events.length,4);
  assert.equal(currentRoleEvents(events,2).analyst.type,'agent_end');
  assert.equal(currentRoleEvents(events,2).auditor,undefined);
});
test('command labels distinguish requested and applied state', () => {
  const command={id:'c',runId:'r',kind:'pause',status:'requested',createdAt:'now'} as Command;
  assert.match(confirmedCommandText(command),/已请求/);
  assert.match(confirmedCommandText({...command,status:'received'}),/已接收/);
  assert.match(confirmedCommandText({...command,status:'applied'}),/已确认/);
});
test('research URLs never expose executable protocols or credentials', () => {
  assert.equal(safeExternalUrl('javascript:alert(1)'),undefined);
  assert.equal(safeExternalUrl('data:text/html,<script>bad</script>'),undefined);
  assert.equal(safeExternalUrl('https://u:p@example.org'),undefined);
  assert.equal(safeExternalUrl('https://doi.org/10.1000/example'),'https://doi.org/10.1000/example');
});
test('unknown or absent supplier costs never display as zero dollars', () => {
  assert.equal(reportedCost({costUsd:0,costKnown:false}),undefined);
  assert.equal(reportedCost({costUsd:null}),undefined);
  assert.equal(reportedCost({costUsd:NaN}),undefined);
  assert.equal(reportedCost({costUsd:0,costKnown:true}),0);
  assert.equal(reportedCost({costUsd:1.25,costKnown:true}),1.25);
});
test('API credentials only travel in authorization headers and requests never follow redirects', async () => {
  const original=globalThis.fetch;
  let request:{url:string;init?:RequestInit}|undefined;
  globalThis.fetch=async(input,init)=>{request={url:String(input),init};return new Response(JSON.stringify({runs:[],workers:[]}),{headers:{'Content-Type':'application/json'}});};
  try {
    await new ResearchApi('https://research.example.org','PRIVATE_TOKEN').runs();
    assert.equal(request?.url,'https://research.example.org/api/runs');
    assert.equal(new Headers(request?.init?.headers).get('authorization'),'Bearer PRIVATE_TOKEN');
    assert.equal(request?.init?.redirect,'error');
    assert.equal(request?.init?.credentials,'omit');
  } finally {globalThis.fetch=original;}
});

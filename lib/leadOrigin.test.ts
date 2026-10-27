import { describe, expect, it } from 'vitest';
import { leadOriginNotes } from './leadOrigin';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

describe('first-party lead origin capture',()=>{
 it('keeps campaign metadata and page path without copying unrelated query data',()=>{
  const notes=leadOriginNotes('Objetivo informado','https://system.wisewolflanguage.com.br/curso?utm_source=google&utm_medium=cpc&gclid=raw-id&token=secret','https://www.google.com/search?q=private');
  expect(notes).toContain('"utm_source":"google"');expect(notes).toContain('"gclid":"present"');expect(notes).toContain('"referrer_host":"www.google.com"');expect(notes).not.toContain('secret');expect(notes).not.toContain('raw-id');expect(notes).not.toContain('q=private');
 });
 it('adds initial and current page evidence to the existing public intake request, preserving the body',async()=>{
  const storage=new Map<string,string>();const calls:unknown[][]=[];
  const location={hostname:'wisewolflanguage.com.br',origin:'https://wisewolflanguage.com.br',href:'https://wisewolflanguage.com.br/blog/fixture?utm_source=google&utm_medium=cpc&gclid=raw&token=secret'};
  const document={referrer:'https://www.google.com/search?q=private'};
  const window:{fetch:(...args:unknown[])=>Promise<unknown>}={fetch:async(...args)=>{calls.push(args);return {};}};
  const context={window,location,document,URL,sessionStorage:{getItem:(key:string)=>storage.get(key),setItem:(key:string,value:string)=>storage.set(key,value)}};
  runInNewContext(readFileSync(join(__dirname,'../public/school-origin-tracking.js'),'utf8'),context);
  location.href='https://wisewolflanguage.com.br/ingles-para-viagens';
  await window.fetch('https://api.wisewolflanguage.com.br/rest/v1/crm_leads',{method:'POST',body:JSON.stringify([{name:'Fixture',notes:'Objetivo'}])});
  const request=JSON.parse((calls[0][1] as {body:string}).body)[0];
  expect(request.name).toBe('Fixture');expect(request.notes).toContain('/blog/fixture');expect(request.notes).toContain('/ingles-para-viagens');expect(request.notes).not.toContain('token');expect(request.notes).not.toContain('secret');expect(request.notes).not.toContain('raw');
  await window.fetch('https://api.wisewolflanguage.com.br/rest/v1/profiles',{method:'POST',body:'{"name":"Fixture"}'});
  expect((calls[1][1] as {body:string}).body).toBe('{"name":"Fixture"}');
 });
});

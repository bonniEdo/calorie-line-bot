const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createHmac,webcrypto}=require('node:crypto');
const env={LINE_CHANNEL_SECRET:'test-channel-secret',APPS_SCRIPT_WEBHOOK_URL:'https://script.test/exec',APPS_SCRIPT_RELAY_SECRET:'test-relay-secret'};
function setup(upstream=async()=>new Response('{"ok":true}')) {
  const calls=[],logs=[];
  const context=vm.createContext({URL,Request,Response,TextEncoder,crypto:webcrypto,btoa:value=>Buffer.from(value,'binary').toString('base64'),console:{error:(...args)=>logs.push(args)},fetch:async(...args)=>{calls.push(args);return upstream(...args);}});
  vm.runInContext(fs.readFileSync('cloudflare-worker/src/index.js','utf8').replace('export default {','this.worker = {'),context);
  const request=raw=>new Request('https://relay.test/',{method:'POST',body:raw,headers:{'x-line-signature':createHmac('sha256',env.LINE_CHANNEL_SECRET).update(raw).digest('base64')}});
  return {worker:context.worker,calls,logs,request};
}
test('LINE relay verifies signatures and forwards only commands and membership events from groups',async()=>{
  const s=setup();
  const chat={type:'message',source:{type:'group'},message:{type:'text',text:'聊天'}},command={...chat,message:{type:'text',text:'啟用 排行'}},membership={type:'memberJoined',source:{type:'group'}};
  const response=await s.worker.fetch(s.request(JSON.stringify({events:[chat,command,membership]})),env);
  assert.equal(response.status,200);assert.equal(s.calls.length,1);
  assert.deepEqual(JSON.parse(s.calls[0][1].body).events,[command,membership]);
  assert.equal(new URL(s.calls[0][0]).searchParams.get('key'),env.APPS_SCRIPT_RELAY_SECRET);
  const invalid=await s.worker.fetch(new Request('https://relay.test/',{method:'POST',body:'{}',headers:{'x-line-signature':'wrong'}}),env);
  assert.equal(invalid.status,401);assert.equal(s.calls.length,1);
  const ignored=await s.worker.fetch(s.request(JSON.stringify({events:[chat]})),env);
  assert.equal((await ignored.json()).ignored,true);assert.equal(s.calls.length,1);
});
test('LINE relay rejects malformed or non-object signed payloads without an uncaught exception',async()=>{
  for(const raw of ['{','null','[]','"text"']) {
    const s=setup();const response=await s.worker.fetch(s.request(raw),env);
    assert.equal(response.status,400);assert.equal(s.calls.length,0);
  }
});
test('LINE relay returns a recoverable gateway failure for network and malformed upstream responses',async()=>{
  for(const upstream of [async()=>{throw new Error('private upstream response');},async()=>new Response('null'),async()=>new Response('<html>Error</html>'),async()=>new Response('{"ok":false,"private":"data"}')]) {
    const s=setup(upstream);const response=await s.worker.fetch(s.request('{"events":[]}'),env);
    assert.equal(response.status,502);assert.equal((await response.json()).error,'upstream_failed');
    assert.ok(!JSON.stringify(s.logs).includes('private'));
  }
});
test('LINE relay health and configuration failures need no external calls',async()=>{
  const s=setup();
  assert.equal((await s.worker.fetch(new Request('https://relay.test/'),{})).status,200);
  assert.equal((await s.worker.fetch(new Request('https://relay.test/',{method:'DELETE'}),env)).status,405);
  assert.equal((await s.worker.fetch(s.request('{}'),{})).status,500);
  assert.equal(s.calls.length,0);
});

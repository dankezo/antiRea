/** Actual local HTTP integration tests: same SaaS server in baseline vs protected mode. */
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const base=path.resolve(__dirname,'..');
const processes=[];
async function server(mode,port){
 const proc=spawn(process.execPath,['benchmark/demo/server.cjs','--mode',mode,'--port',String(port)],{cwd:base,stdio:'ignore'});processes.push(proc);
 for(let i=0;i<100;i++){
  try{const r=await fetch(`http://127.0.0.1:${port}/api/summary`);if(r.ok)return `http://127.0.0.1:${port}`;}catch{}
  await new Promise(r=>setTimeout(r,30));
 }
 throw new Error(`start ${mode} failed`);
}
after(()=>{for(const proc of processes)proc.kill('SIGTERM');});

test('same fixture and workflows, measurable server-side defenses',async()=>{
 const baseline=await server('baseline',4183);
 const protectedUrl=await server('protected',4184);
 const b=await (await fetch(`${baseline}/api/accounts`)).json();
 const p=await (await fetch(`${protectedUrl}/api/accounts`)).json();
 assert.deepEqual(b,p,'input fixtures must be identical');
 for(const origin of [baseline,protectedUrl]){
  const home=await fetch(origin+'/');assert.equal(home.status,200);
  const text=await home.text();assert.match(text,/Northstar/);
  const created=await fetch(origin+'/api/tickets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subject:'Ticket from test'})});
  assert.equal(created.status,201);
  const s=await (await fetch(origin+'/api/summary')).json();assert.equal(s.mrr,37620);
  const c=await fetch(origin+'/api/v1/internal/schema-export');assert.equal(c.status,404);
 }
 const guarded=await fetch(protectedUrl+'/');assert.ok(guarded.headers.get('content-security-policy'));
 const plain=await fetch(baseline+'/');assert.equal(plain.headers.get('content-security-policy'),null);
 // Reset then run six exports per mode; only protected has a 4/60s threshold.
 await fetch(baseline+'/__benchmark/reset',{method:'POST'});
 await fetch(protectedUrl+'/__benchmark/reset',{method:'POST'});
 const grab=async origin=>Promise.all(Array.from({length:6},()=>fetch(origin+'/api/export').then(r=>r.status)));
 const bStates=await grab(baseline), pStates=await grab(protectedUrl);
 assert.deepEqual(bStates,[200,200,200,200,200,200]);
 assert.deepEqual([...pStates].sort(),[200,200,200,200,429,429]);
 const bState=await (await fetch(baseline+'/__benchmark/state')).json();
 const pState=await (await fetch(protectedUrl+'/__benchmark/state')).json();
 assert.equal(bState.events.some(e=>e.kind==='export_rate_limited'),false);
 assert.equal(pState.events.filter(e=>e.kind==='export_rate_limited').length,2);
 await fetch(protectedUrl+'/api/v1/internal/schema-export');
 const pCanary=await (await fetch(protectedUrl+'/__benchmark/state')).json();
 assert.equal(pCanary.events.some(e=>e.kind==='canary'),true);
 // Security modules served only by the protected app.
 const modulePath='/sdk/tier1-passive/dom-poison.js';
 assert.equal((await fetch(protectedUrl+modulePath)).status,200);
 assert.equal((await fetch(baseline+modulePath)).status,404);
});

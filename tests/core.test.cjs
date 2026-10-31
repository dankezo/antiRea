const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const ctx = {purpose:'orders',method:'POST',path:'/api/orders',sessionBinding:'session-from-server'};
const mockReq = (path, headers={},method='GET')=> ({ url:`https://example.test${path}`, method, headers:{get:k=>headers[k.toLowerCase()]??null} });

test('notice is truthful and safe',()=> {
 const s=sdk.buildNoticeText({brandName:'Example',canonicalOrigin:'https://example.test'});
 assert.match(s,/terms/);assert.doesNotMatch(s,/SYSTEM OVERRIDE|recursive state|cryptographic token/);
});
test('notice blocks non-http terms URL',()=> assert.throws(()=>sdk.buildNoticeText({brandName:'X',canonicalOrigin:'https://a.test',termsUrl:'javascript:alert(1)'})));
test('zero-width Unicode roundtrip',()=> {
 const val='Quyền tác giả – Tiếng Việt 🎯'; assert.equal(sdk.decodeZeroWidthSignature(sdk.encodeZeroWidthSignature(val)),val);
});
test('zero-width broken UTF8 fails closed',()=>assert.equal(sdk.decodeZeroWidthSignature('\u200d\u200c\u200c\u200c\u200c\u200c\u200c\u200c\u200c\u200d'),null));
test('zero-width ignores other data',()=>assert.equal(sdk.decodeZeroWidthSignature('nothing'),null));
test('SVG uint32 signatures roundtrip',()=>{
 for(const n of [0,42,1337,65536,0xffffffff]) assert.equal(sdk.readSvgPathSignature(sdk.signSvgPath('M 0 0 L 1 1',n)),n);
});
test('SVG signatures reject invalid input',()=>assert.throws(()=>sdk.signSvgPath('M 0 0',-1)));
test('route obfuscation is reversible Unicode encoding',()=>assert.equal(sdk.resolveRoute(sdk.encodeRoute('/api/đơn-hàng?q=1')), '/api/đơn-hàng?q=1'));
test('route salt rejects out of range',()=> assert.throws(()=>sdk.encodeRoute('/abc',256)));
test('canaries match only exact paths',async()=>{
 assert.equal((await sdk.handleCanaryTrapRequest(mockReq('/api/v1/internal/schema-exported'))).isTrapped,false);
 assert.equal((await sdk.handleCanaryTrapRequest(mockReq('/api/v1/internal/schema-export'))).isTrapped,true);
});
test('canaries never automatically attribute spoofed header identity',async()=>{
 let alert;await sdk.handleCanaryTrapRequest(mockReq('/api/v1/internal/schema-export', {'x-forwarded-for':'1.2.3.4','x-user-id':'victim'}),{onAlert:a=>{alert=a}});
 assert.equal(alert.ip,undefined);assert.equal(alert.userId,undefined);
});
test('canaries attribute only explicitly trusted proxy headers and server session',async()=>{
 let alert;await sdk.handleCanaryTrapRequest(mockReq('/api/v1/internal/schema-export', {'cf-connecting-ip':'203.0.113.10','user-agent':'audit'}),{trustedIpHeader:'cf-connecting-ip',resolveUserId:()=> 'verified-user',onAlert:a=>{alert=a}});
 assert.equal(alert.ip,'203.0.113.10');assert.equal(alert.userId,'verified-user');
});
test('canaries ignore cross-site browser requests by default',async()=>{
 let called=false;
 const r=await sdk.handleCanaryTrapRequest(mockReq('/api/v1/internal/schema-export',{'sec-fetch-site':'cross-site'}),{onAlert:()=>{called=true}});
 assert.equal(r.isTrapped,false); assert.equal(called,false);
});
test('canary logging errors do not break app',async()=>{
 const r=await sdk.handleCanaryTrapRequest(mockReq('/api/v1/internal/schema-export'),{onAlert:()=>{throw Error('db down')}});
 assert.equal(r.status,404);
});
test('canary robots snippet',()=>{
 for(const p of sdk.CANARY_ENDPOINTS) assert.ok(sdk.robotsTxtSnippet().includes('Disallow: '+p));
});
test('SSR functions do not require window or document',()=> {
 assert.equal(typeof sdk.initCdpGuard({onDetected:()=>{},enabled:true}),'function');
 assert.equal(typeof sdk.mountForensicWatermark({token:'abcd',enabled:true}),'function');
});
test('behavior shield SSR is a no-op',()=>{
 const shield=new sdk.BehaviorShield({onAnomaly:()=>{},enabled:true});assert.doesNotThrow(()=>{shield.start();shield.stop()});
});
test('AES-GCM envelope roundtrip with required shared replay callback',async()=>{
 const key=await sdk.createEnvelopeKey();const guard=sdk.createInMemoryReplayGuard();
 const e=await sdk.encryptPayload({secret:'hello',n:3},key,ctx);
 assert.deepEqual(await sdk.decryptPayload(e,key,ctx,{markNonceOnce:guard}),{secret:'hello',n:3});
 await assert.rejects(()=>sdk.decryptPayload(e,key,ctx,{markNonceOnce:guard}),/Replay detected/);
});
test('AES-GCM envelope cannot decrypt under a different request path',async()=>{
 const key=await sdk.createEnvelopeKey(), e=await sdk.encryptPayload({id:2},key,ctx);
 await assert.rejects(()=>sdk.decryptPayload(e,key,{...ctx,path:'/api/admin'},{markNonceOnce:sdk.createInMemoryReplayGuard()}));
});
test('AES-GCM envelope cannot decrypt after ciphertext modification',async()=>{
 const key=await sdk.createEnvelopeKey(), e=await sdk.encryptPayload({id:2},key,ctx);
 const tampered={...e,payload: e.payload.slice(0,-1)+(e.payload.endsWith('A')?'B':'A')};
 await assert.rejects(()=>sdk.decryptPayload(tampered,key,ctx,{markNonceOnce:sdk.createInMemoryReplayGuard()}));
});
test('AES-GCM expiry is enforced',async()=>{
 const key=await sdk.createEnvelopeKey(), e=await sdk.encryptPayload({id:2},key,ctx);
 await assert.rejects(()=>sdk.decryptPayload(e,key,ctx,{markNonceOnce:sdk.createInMemoryReplayGuard(),now:e.ts+20000}),/expired/);
});
test('AES-GCM replay guard must be present',async()=>{
 const key=await sdk.createEnvelopeKey(), e=await sdk.encryptPayload({id:2},key,ctx);
 await assert.rejects(()=>sdk.decryptPayload(e,key,ctx,{}),/replay guard/);
});
test('AES-GCM keys are nonextractable',async()=>{
 const key=await sdk.createEnvelopeKey();assert.equal(key.extractable,false);
 await assert.rejects(()=>crypto.subtle.exportKey('raw',key));
});
test('AES-GCM purpose required',async()=>{
 const key=await sdk.createEnvelopeKey();await assert.rejects(()=>sdk.encryptPayload({ok:true},key,{...ctx,purpose:''}),/Provide purpose/);
});
test('no hidden local screenshot or keyboard tracking in shield code',()=>{
 const fs=require('node:fs');const shield=fs.readFileSync('src/tier4-forensic/behavior-shield.ts','utf8');
 assert.doesNotMatch(shield,/keydown|PrintScreen|screenshot_shortcut/);
});

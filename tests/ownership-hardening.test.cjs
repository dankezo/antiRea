"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const {createOwnershipProbe} = require('../dist/index.js');
function rng(seed){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
test('ownership seeded late streams equal brute-force rolling watermark',()=>{
  for(let seed=1;seed<=40;seed++){
    const r=rng(seed), events=[{ts:1000,owner:'unknown',route:'private'}];let watermark=1000;
    const configs=[{windowSeconds:10,minEvents:3,minDistinctOwners:2,minRatio:.3},{windowSeconds:50,minEvents:4,minDistinctOwners:3,minRatio:.5}];
    const probe=createOwnershipProbe({resolveOwner:id=>id==='unknown'?null:id,publicRoutes:['public'],windows:configs});
    probe.observe('__proto__',{objectId:'unknown',route:'private',ts:1000});
    for(let i=0;i<300;i++){
      const ts=Math.max(0,watermark+Math.floor(r()*20)-12),owner=r()<.2?'unknown':'o'+Math.floor(r()*9),route=r()<.15?'public':'private';
      watermark=Math.max(watermark,ts);
      events.push({ts,owner,route});
      const result=probe.observe('__proto__',{objectId:owner,route,ts});
      assert.equal(result.truncated,false);
      configs.forEach((cfg,j)=>{
        const live=events.filter(e=>e.route!=='public'&&e.ts>=watermark-cfg.windowSeconds);
        const owners=new Set(live.filter(e=>e.owner!=='unknown').map(e=>e.owner));
        const ratio=live.length?owners.size/live.length:0;
        const w=result.windows[j];
        assert.equal(w.countedTouches,live.length,`seed=${seed} step=${i} window=${j}`);
        assert.equal(w.distinctOwners,owners.size);assert.equal(w.ratio,ratio);
        assert.equal(w.unknownOwnerTouches,live.filter(e=>e.owner==='unknown').length);
        assert.equal(w.verdict,live.length<cfg.minEvents?'insufficient_history':owners.size>=cfg.minDistinctOwners&&ratio>=cfg.minRatio?'flag':'ok');
      });
    }
  }
});
test('ownership exact inclusive window boundary and no backward resurrection',()=>{
  const p=createOwnershipProbe({resolveOwner:id=>id,windows:[{windowSeconds:10,minEvents:1,minDistinctOwners:1,minRatio:1}]});
  p.observe('u',{objectId:'a',ts:10});
  assert.equal(p.check('u',20).windows[0].countedTouches,1);
  assert.equal(p.check('u',20.001).windows[0].countedTouches,0);
  assert.equal(p.check('u',1).windows[0].countedTouches,0);
  assert.equal(p.observe('u',{objectId:'late',ts:10}).windows[0].countedTouches,0);
});
test('ownership cap suppresses partial flags until missing history expires',()=>{
  const p=createOwnershipProbe({resolveOwner:id=>id,maxIdentities:1,maxEventsPerIdentity:2,maxTotalEvents:2,windows:[{windowSeconds:10,minEvents:1,minDistinctOwners:1,minRatio:0}]});
  p.observe('u',{objectId:'a',ts:1});p.observe('u',{objectId:'b',ts:2});
  const r=p.observe('u',{objectId:'c',ts:3});
  assert.equal(r.truncated,true);assert.equal(r.flagged,false);assert.equal(r.windows[0].scored,0);assert.equal(r.windows[0].evidence,null);
  assert.equal(p.check('u',13).truncated,true);
  assert.equal(p.check('u',13.001).truncated,false);
  assert.equal(p.observe('v',{objectId:'a',ts:14}).truncated,true);
  assert.equal(p.size().identities,1);
  p.reset('u');assert.equal(p.observe('v',{objectId:'a',ts:14}).truncated,true);
  p.reset();assert.deepEqual(p.size(),{identities:0,cachedOwners:0});
});
test('ownership global cap, cache rollover, zero sample and prototype owner keys',()=>{
  const p=createOwnershipProbe({resolveOwner:id=>id,ownerCacheLimit:1,maxTotalEvents:1,maxEvidenceOwners:0,windows:[{minEvents:1,minDistinctOwners:1,minRatio:0}]});
  const a=p.observe('a',{objectId:'__proto__',ts:1});assert.deepEqual(a.windows[0].evidence.owners,[]);
  assert.equal(p.observe('b',{objectId:'x',ts:1}).truncated,true);
  p.reset('a');assert.equal(p.observe('b',{objectId:'x',ts:2}).truncated,true);
  assert.equal(p.size().cachedOwners,1);
  const q=createOwnershipProbe({resolveOwner:id=>id,windows:[{minEvents:1,minDistinctOwners:1,minRatio:1}]});
  const counts=q.observe('a',{objectId:'__proto__',ts:1}).windows[0].evidence.ownerTouchCounts;
  assert.equal(Object.hasOwn(counts,'__proto__'),true);assert.equal(counts.__proto__,1);
  assert.equal(Object.getPrototypeOf(counts),Object.prototype);
});
test('ownership rejects invalid configuration and inputs before growing state',()=>{
  for(const value of [NaN,Infinity,-1,0,1.5]){
    for(const key of ['maxIdentities','maxEventsPerIdentity','maxTotalEvents','ownerCacheLimit']) assert.throws(()=>createOwnershipProbe({resolveOwner:id=>id,[key]:value}));
  }
  for(const value of [NaN,Infinity,-1,1.1]) assert.throws(()=>createOwnershipProbe({resolveOwner:id=>id,windows:[{minRatio:value}]}));
  for(const value of [NaN,Infinity,0,-1,31536001]) assert.throws(()=>createOwnershipProbe({resolveOwner:id=>id,windows:[{windowSeconds:value}]}));
  for(const key of ['minEvents','minDistinctOwners'])for(const value of [NaN,Infinity,0,-1,1.5])assert.throws(()=>createOwnershipProbe({resolveOwner:id=>id,windows:[{[key]:value}]}));
  assert.throws(()=>createOwnershipProbe({resolveOwner:id=>id,windows:Array.from({length:17},()=>({}))}));
  assert.throws(()=>createOwnershipProbe({resolveOwner:id=>id,maxEvidenceOwners:-1}));
  const p=createOwnershipProbe({resolveOwner:id=>id});
  for(const ts of [NaN,Infinity,-1,8640000000001]){assert.throws(()=>p.observe('u',{objectId:'x',ts}));assert.throws(()=>p.check('u',ts));}
  for(const id of ['',null,5,'a'.repeat(1025)]){assert.throws(()=>p.observe(id,{objectId:'x',ts:1}));assert.throws(()=>p.check(id));assert.throws(()=>p.observe('u',{objectId:id,ts:1}));}
  assert.equal(p.size().identities,0);
});
test('ownership callback rejection cannot become an unhandled rejection',async()=>{
  let calls=0;
  const p=createOwnershipProbe({resolveOwner:id=>id,onEvidence:async()=>{calls++;throw Error('operator');},windows:[{minEvents:1,minDistinctOwners:1,minRatio:1}]});
  p.observe('u',{objectId:'a',ts:1});p.observe('u',{objectId:'a',ts:2});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});
test('ownership frozen default flag boundaries and evidence sample are exact',()=>{
  const p=createOwnershipProbe({resolveOwner:id=>id});
  for(let i=0;i<19;i++)assert.equal(p.observe('u',{objectId:'o'+i%10,ts:100+i}).flagged,false);
  const result=p.observe('u',{objectId:'o9',ts:119});
  assert.equal(result.flagged,true);assert.equal(result.windows[0].ratio,.5);
  assert.equal(result.windows[0].evidence.owners.length,10);
  assert.equal(p.check('u',3700).windows[0].countedTouches,20);
  assert.equal(p.check('u',3700.1).windows[0].countedTouches,19);
});
test('ownership each cap reclaims expired storage and reset reclaims global accounting',()=>{
  for(const limits of [{maxEventsPerIdentity:2},{maxTotalEvents:2}]){
    const p=createOwnershipProbe({resolveOwner:id=>id,...limits,windows:[{windowSeconds:10,minEvents:1,minDistinctOwners:1,minRatio:0}]});
    p.observe('u',{objectId:'a',ts:10});p.observe('u',{objectId:'b',ts:11});
    assert.equal(p.observe('u',{objectId:'c',ts:30}).truncated,false);
    assert.equal(p.check('u').windows[0].countedTouches,1);
  }
  const p=createOwnershipProbe({resolveOwner:id=>id,maxTotalEvents:1});
  p.observe('u',{objectId:'a',ts:1});p.reset();assert.equal(p.observe('u',{objectId:'b',ts:2}).truncated,false);
});
test('ownership missing event at exact expiry still suppresses an otherwise valid flag',()=>{
  const p=createOwnershipProbe({resolveOwner:id=>id,maxEventsPerIdentity:2,windows:[{windowSeconds:10,minEvents:1,minDistinctOwners:1,minRatio:0}]});
  p.observe('u',{objectId:'a',ts:10});p.observe('u',{objectId:'b',ts:11});p.observe('u',{objectId:'c',ts:12});
  const result=p.observe('u',{objectId:'d',ts:22});assert.equal(result.truncated,true);assert.equal(result.flagged,false);assert.equal(result.windows[0].scored,0);
});
test('ownership timestamps reject coercible nonnumeric values',()=>{
  const p=createOwnershipProbe({resolveOwner:id=>id});
  for(const ts of ['1',null,undefined,true])assert.throws(()=>p.observe('u',{objectId:'a',ts}));
});

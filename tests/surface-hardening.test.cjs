"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createSurfaceGuard}=require('../dist');
test('surface cycles, sparse arrays and deep shapes obey the traversal cap',()=>{
  const array=[];array.push(array);
  const object={};object.self=object;
  const sparse=[];sparse.length=1e9;
  let deep={secret:'x'};for(let i=0;i<10000;i++)deep={a:deep};
  const guard=createSurfaceGuard({maxScanNodes:100});
  for(const value of [array,object,sparse,deep]){
    const result=guard.inspectResponse('/x',value);assert.equal(result.truncated,true);assert.equal(result.ok,true);
  }
});
test('surface truncated strip/block results cannot advertise safe uninspected data',()=>{
  for(const mode of ['strip','block']){
    const result=createSurfaceGuard({mode,maxScanNodes:1}).inspectResponse('/x',{safe:1,password:'x'});
    assert.equal(result.truncated,true);assert.equal(result.ok,false);assert.equal(Object.hasOwn(result,'sanitized'),false);
  }
});
test('surface strip preserves prototype-shaped own keys without prototype mutation',()=>{
  const value=JSON.parse('{"__proto__":{"safe":1,"secret":"x"},"password":"x","constructor":2}');
  const result=createSurfaceGuard({mode:'strip'}).inspectResponse('/x',value);
  assert.equal(result.ok,true);assert.equal(result.truncated,false);
  assert.equal(Object.getPrototypeOf(result.sanitized),Object.prototype);
  assert.equal(Object.hasOwn(result.sanitized,'__proto__'),true);
  assert.deepEqual(result.sanitized.__proto__,{safe:1});assert.equal(result.sanitized.constructor,2);
  assert.equal(value.__proto__.secret,'x');
});
test('surface accessor values are not executed or marked as sanitized',()=>{
  let calls=0;const value={};Object.defineProperty(value,'safe',{enumerable:true,get(){calls++;throw Error('getter');}});
  const result=createSurfaceGuard({mode:'strip'}).inspectResponse('/x',value);
  assert.equal(calls,0);assert.equal(result.truncated,true);assert.equal(result.ok,false);
});
test('surface caps and modes validate before inspection',()=>{
  for(const maxScanNodes of [NaN,Infinity,0,-1,1.5,1000001])assert.throws(()=>createSurfaceGuard({maxScanNodes}));
  assert.throws(()=>createSurfaceGuard({mode:'bogus'}));
});

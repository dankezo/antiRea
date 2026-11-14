"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createEvalueTripwire}=require('../dist');
test('evalue capacity rejects atomically and preserves complete histories',()=>{
  const t=createEvalueTripwire({maxCohorts:1,maxRecordsPerCohort:2,maxMembersPerCohort:1,maxRecordsPerStep:2});
  t.observe({cohortId:'__proto__',identity:'u',records:[1,2]});const before=t.getSnapshot('__proto__');
  for(const input of [{cohortId:'new',records:[]},{cohortId:'__proto__',records:[3]},{cohortId:'__proto__',identity:'v',records:[]},{cohortId:'__proto__',records:[1,2,3]}]){
    assert.throws(()=>t.observe(input),/capacity/);assert.deepEqual(t.getSnapshot('__proto__'),before);
  }
  assert.equal(t.getSnapshot('new'),null);t.clearCohort('__proto__');assert.doesNotThrow(()=>t.observe({cohortId:'new',records:[3]}));
});
test('evalue global cap and merge dedup accounting are exact',()=>{
  const t=createEvalueTripwire({maxTotalRecords:4,maxRecordsPerCohort:3});
  t.observe({cohortId:'a',records:[1,2]});t.observe({cohortId:'b',records:[2,3]});
  assert.throws(()=>t.observe({cohortId:'c',records:[4]}),/capacity/);
  assert.equal(t.mergeCohorts('a','b').unionRecords,3);
  assert.doesNotThrow(()=>t.observe({cohortId:'c',records:[4]}));
  const before=t.getSnapshot('a');assert.throws(()=>t.mergeCohorts('a','c'),/capacity/);assert.deepEqual(t.getSnapshot('a'),before);
  t.clearCohort('a');t.clearCohort('a');assert.doesNotThrow(()=>t.observe({cohortId:'d',records:[5,6,7]}));
});
test('evalue hostile payloads and numerically degenerate parameters reject',()=>{
  for(const name of ['maxCohorts','maxRecordsPerCohort','maxTotalRecords','maxMembersPerCohort','maxRecordsPerStep'])for(const value of [NaN,Infinity,0,-1,1.5])assert.throws(()=>createEvalueTripwire({[name]:value}));
  assert.throws(()=>createEvalueTripwire({mu0:Number.MIN_VALUE}),/numerical/);
  assert.throws(()=>createEvalueTripwire({alpha:Number.MIN_VALUE}),/numerical/);
  const t=createEvalueTripwire();
  for(const records of [[NaN],[Infinity],[-1],[.1],'123'])assert.throws(()=>t.observe({cohortId:'u',records}));
  for(const identity of ['',{},'x'.repeat(1025)])assert.throws(()=>t.observe({cohortId:'u',identity,records:[]}));
  assert.equal(t.getSnapshot('u'),null);
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function withTemp(fn) { const d=fs.mkdtempSync(path.join(os.tmpdir(),'anti-rea-test-'));try{return fn(d)}finally{fs.rmSync(d,{recursive:true,force:true})} }
test('artifact scan passes when no sourcemaps are included',()=>withTemp(d=>{
 fs.writeFileSync(path.join(d,'a.js'),'console.log("safe")');
 const r=spawnSync(python,['scripts/verify-build.py',d],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).files_with_findings,0);
}));
test('artifact scan fails when a JS sourcemap is in public assets',()=>withTemp(d=>{
 fs.writeFileSync(path.join(d,'app.js.map'),'{}');
 const r=spawnSync(python,['scripts/verify-build.py',d],{encoding:'utf8'});
 assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).findings[0].signal,'public-source-map');
}));
test('artifact scan flags sourceMappingURL for review',()=>withTemp(d=>{
 fs.writeFileSync(path.join(d,'app.js'),'//# sourceMappingURL=app.js.map');
 const r=spawnSync(python,['scripts/verify-build.py',d],{encoding:'utf8'});
 assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).findings[0].severity,'review');
}));
test('artifact scan does not follow symlinks',t=>withTemp(d=>{
 const target=path.join(os.tmpdir(),'antirea-symlink-target.js');
 try { fs.symlinkSync(target,path.join(d,'a.js')); } catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES') { t.skip('Creating symlinks requires additional privileges'); return; } throw e; }
 const r=spawnSync(python,['scripts/verify-build.py',d],{encoding:'utf8'});
 assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).files_with_findings,0);
}));

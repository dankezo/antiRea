#!/usr/bin/env node
'use strict';
// WARNING: Local benchmark server only. Never deploy to production.
/** Deterministic local twin-SaaS benchmark. Only localhost; not a production server. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { handleCanaryTrapRequest } = require('../../dist/tier2-active/honeypot-middleware.js');

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLoopback = req => LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress || '');

const root = path.join(__dirname, 'public');
const arg = k => { const at = process.argv.indexOf(k); return at > -1 ? process.argv[at+1] : undefined; };
const mode = arg('--mode') || 'baseline';
if (!['baseline','protected'].includes(mode)) throw new Error('Mode baseline|protected only');
const port = Number(arg('--port') || (mode === 'baseline' ? 4173 : 4174));
const host = '127.0.0.1';
const securityOn = mode === 'protected';
const limit = 4; // four successful exports per 60-second window; benchmark-only local memory
const windowMs = 60_000;
const exportTimes = new Map();
let events = [];
let ticketCounter = 200;
const accounts = Object.freeze([
 {id:'ACC-041',name:'Acme Analytics',sector:'SaaS',arr:124000,trend:18,health:'Healthy',owner:'Nora Chen'},
 {id:'ACC-052',name:'Vertex Labs',sector:'Infrastructure',arr:98000,trend:12,health:'Healthy',owner:'Mark Rivera'},
 {id:'ACC-063',name:'Orbit Studio',sector:'Design',arr:84000,trend:-4,health:'Watch',owner:'Ivy Tran'},
 {id:'ACC-074',name:'Pine Commerce',sector:'Retail',arr:62000,trend:23,health:'Healthy',owner:'Kai Morgan'},
 {id:'ACC-085',name:'SignalWorks',sector:'Analytics',arr:47000,trend:8,health:'Watch',owner:'Mina Patel'},
 {id:'ACC-096',name:'Atlas Cloud',sector:'Cloud',arr:36000,trend:17,health:'Healthy',owner:'Noah Park'}
]);
const tickets = [];
const json = (res,status,body,headers={}) => {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});
  res.end(JSON.stringify(body));
};
const readBody = async req => {
  let input='';
  for await(const piece of req){input+=piece; if(input.length>8192) throw new Error('payload_too_large');}
  return JSON.parse(input||'{}');
};
const headers = {'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store'};
if(securityOn) {
  headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
  headers['X-Frame-Options']='DENY';
}
const contentTypes={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
const server = http.createServer(async (req,res) => {
  Object.entries(headers).forEach(([k,v])=>res.setHeader(k,v));
  const url = new URL(req.url||'/',`http://${host}:${port}`);
  const p=url.pathname;
  if(p==='/__benchmark/reset' && req.method==='POST') {
    if(!isLoopback(req)) return json(res,403,{error:'loopback_only'});
    events=[]; exportTimes.clear(); tickets.length=0; ticketCounter=200; return json(res,200,{reset:true,mode});
  }
  if(p==='/__benchmark/state') {
    if(!isLoopback(req)) return json(res,403,{error:'loopback_only'});
    return json(res,200,{mode,events,tickets,exportLimit:securityOn?limit:null});
  }
  if(p==='/api/session') return json(res,200,{mode,sessionToken:securityOn?crypto.randomBytes(8).toString('hex'):null,authenticated:false,synthetic:true});
  if(p==='/api/summary') return json(res,200,{mrr:37620,growth:14.2,accounts:accounts.length,pipeline:318000,chart:[35,46,41,57,54,68,62,71,82,78,91,96]});
  if(p==='/api/accounts') { const q=(url.searchParams.get('search')||'').toLowerCase().slice(0,100); return json(res,200,{items:accounts.filter(a=>`${a.name} ${a.sector} ${a.owner}`.toLowerCase().includes(q)),total:accounts.length}); }
  if(p==='/api/tickets' && req.method==='POST') {
    try { const b=await readBody(req); const subject=String(b.subject||'').trim(); if(subject.length<3||subject.length>120) return json(res,400,{error:'invalid_subject'});
      const t={id:`REQ-${++ticketCounter}`,subject,status:'Queued'}; tickets.push(t); return json(res,201,t);
    } catch {return json(res,400,{error:'invalid_json'});}
  }
  if(p==='/api/export' && req.method==='GET') {
    // A real protection that does not rely on hiding browser code: server enforcement.
    if(securityOn){const key='local-fixture';const now=Date.now();const fresh=(exportTimes.get(key)||[]).filter(t=>now-t<windowMs);
      if(fresh.length>=limit){events.push({kind:'export_rate_limited',ts:new Date().toISOString()});return json(res,429,{error:'rate_limited'}, {'Retry-After':'60'});}
      fresh.push(now);exportTimes.set(key,fresh);
    }
    const csv=['id,name,arr',...accounts.map(a=>`${a.id},${a.name},${a.arr}`)].join('\n')+'\n';
    res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="northstar-accounts.csv"'});return res.end(csv);
  }
  if(p==='/api/telemetry'&&req.method==='POST') {
    if(!securityOn)return json(res,404,{error:'not_found'});
    try { const b=await readBody(req); if(['navigator.webdriver=true (weak heuristic)'].includes(b.reason))events.push({kind:'weak_client_signal',reason:b.reason,ts:new Date().toISOString()}); return json(res,202,{accepted:true}); }
    catch {return json(res,400,{error:'invalid_json'});}
  }
  if(p.startsWith('/api/')) {
    if(securityOn){ const trap=await handleCanaryTrapRequest({url:url.href,method:req.method,headers:{get:k=>req.headers[k.toLowerCase()]||null}}, {onAlert:e=>events.push({kind:'canary',path:e.path,method:e.method,ts:e.timestamp})});
      if(trap.isTrapped) return json(res,trap.status,trap.body);
    }
    return json(res,404,{error:'not_found'});
  }
  const local=p==='/'?'/index.html':p;
  const f=path.resolve(root, '.'+local);
  if(!(f===root||f.startsWith(root+path.sep)) || !fs.existsSync(f) || !fs.statSync(f).isFile())return json(res,404,{error:'not_found'});
  if(!securityOn && local.startsWith('/sdk/'))return json(res,404,{error:'not_found'});
  const ext=path.extname(f);
  res.setHeader('Content-Type',contentTypes[ext]||'application/octet-stream');
  if(ext==='.html')return res.end(fs.readFileSync(f,'utf8').replaceAll('__MODE__',mode));
  return fs.createReadStream(f).pipe(res);
});
server.listen(port,host,()=>process.stdout.write(`antiRea twin SaaS ${mode}: http://${host}:${port}\n`));

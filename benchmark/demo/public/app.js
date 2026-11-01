/** One source serves both variants. Protection imports only occur in protected mode. */
const mode = document.body.dataset.mode;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const escapeHtml = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n);
const api=async (u,options) => { const r=await fetch(u,options); if(!r.ok) throw new Error(`HTTP ${r.status}`);return r.json();};
const notify=s=>{const t=$('#toast');t.textContent=s;t.style.display='block';clearTimeout(window.__toastTimer);window.__toastTimer=setTimeout(()=>t.style.display='none',3500);};
let accounts = [];
async function loadSummary(){const data=await api('/api/summary');$('#metric-mrr').textContent=money(data.mrr);$('#metric-accounts').textContent=String(data.accounts).padStart(2,'0');$('#metric-pipeline').textContent=money(data.pipeline);}
async function loadAccounts(){const q=$('#account-search').value;const data=await api('/api/accounts?search='+encodeURIComponent(q));accounts=data.items;const html=accounts.map(a=>`<tr><td><div class="company"><span class="company-icon">${escapeHtml(a.name[0])}</span><div><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.id)}</small></div></div></td><td>${escapeHtml(a.sector)}</td><td><strong>${money(a.arr)}</strong></td><td class="${a.trend>=0?'trend-up':'trend-down'}">${a.trend>=0?'↗':'↘'} ${a.trend>0?'+':''}${a.trend}%</td><td><span class="pill ${a.health==='Healthy'?'good':'watch'}">● ${escapeHtml(a.health)}</span></td><td class="row-dots">⋯</td></tr>`).join('');$('#accounts-body').innerHTML=html;$('#empty-state').hidden=accounts.length>0;$('#accounts-count').textContent=`Showing ${accounts.length} of ${data.total} accounts`;}
const titles={overview:'Good morning, Nora',accounts:'Your accounts',pipeline:'Opportunity pipeline',activity:'Workspace activity',settings:'Workspace settings',help:'Help center'};
function switchView(view){$$('[data-view]').forEach(n=>n.classList.toggle('active',n.dataset.view===view));$('#view-name').textContent=view[0].toUpperCase()+view.slice(1);$('#page-title').innerHTML=escapeHtml(titles[view])+' <span class="sun">✳</span>';$('#page-subtitle').textContent=view==='overview'?"Here's what's happening across your business today.":'Explore the same synthetic workspace, one workflow at a time.';if(view==='accounts')$('#accounts').scrollIntoView({block:'start',behavior:'smooth'});else window.scrollTo({top:0,behavior:'smooth'});}
$$('[data-view]').forEach(n=>n.addEventListener('click',()=>switchView(n.dataset.view)));
$('#explore-link').addEventListener('click',()=>switchView('accounts'));
$('#account-search').addEventListener('input',()=>{loadAccounts().catch(e=>notify(e.message));});
$('#refresh-button').addEventListener('click',()=>loadAccounts().then(()=>notify('Accounts refreshed')));
$('#new-request').addEventListener('click',()=>$('#ticket-dialog').showModal());
$('#close-dialog').addEventListener('click',()=>$('#ticket-dialog').close());
$('#cancel-dialog').addEventListener('click',()=>$('#ticket-dialog').close());
$('#ticket-form').addEventListener('submit',async e=>{e.preventDefault();try {const subject=$('#subject').value;const result=await api('/api/tickets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subject})});$('#ticket-dialog').close();$('#ticket-form').reset();notify('Created '+result.id);}catch(err){notify('Could not create request: '+err.message);}});
$('#export-button').addEventListener('click',async()=>{try {const r=await fetch('/api/export');if(r.status===429){notify('Export limit reached. Try again in a minute.');return;}if(!r.ok)throw new Error('Export failed');const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='northstar-accounts.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('Report ready');} catch(err){notify(err.message);}});
$('#bell').addEventListener('click',()=>notify('No new notifications'));
await Promise.all([loadSummary(),loadAccounts()]);
window.__northstarReady=true;
if(mode==='protected') {
  // Import the compiled antiRea TypeScript SDK, NOT an independently reimplemented mock.
  const [{injectAgentNotice},{mountForensicWatermark},{initCdpGuard}]=await Promise.all([
    import('/sdk/tier1-passive/dom-poison.js'),
    import('/sdk/tier4-forensic/watermark.js'),
    import('/sdk/tier2-active/cdp-guard.js')
  ]);
  injectAgentNotice({brandName:'Northstar Demo',canonicalOrigin:location.origin,termsUrl:'/terms'});
  const session=await api('/api/session');
  mountForensicWatermark({token:session.sessionToken,enabled:true,opacity:0.045});
  initCdpGuard({enabled:true,onDetected:reason=>fetch('/api/telemetry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason})}).then(r=>r.text()).catch(()=>{}),intervalMs:30000});
}
window.__northstarFullyReady=true;

#!/usr/bin/env python3
"""Measured Playwright A/B benchmark against two LOCAL Northstar apps.
Does not claim to emulate or replace REA. Writes evidence, errors and skips.
"""
import argparse, datetime, json, os, pathlib, platform, shutil, statistics, sys, time, urllib.request
from playwright.sync_api import sync_playwright, Error as PlaywrightError

HERE=pathlib.Path(__file__).resolve().parent
DEFAULT_OUT=HERE/'results'/'browser.json'

def fetch(url, method='GET'):
    req=urllib.request.Request(url,method=method)
    with urllib.request.urlopen(req,timeout=8) as r:
        return json.loads(r.read()),r.status

def run_case(browser,name,mode,origin,out,iterations):
    fetch(origin+'/__benchmark/reset','POST')
    context=browser.new_context(viewport={'width':1440,'height':1100},accept_downloads=True,locale='en-US',reduced_motion='reduce')
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    t0=time.perf_counter()
    page.goto(origin+'/',wait_until='networkidle',timeout=20000)
    page.wait_for_function('window.__northstarFullyReady===true',timeout=20000)
    load_ms=round((time.perf_counter()-t0)*1000,1)
    page.screenshot(path=str(out/f'{name}-{mode}.png'),full_page=True)
    dom=page.evaluate('''() => ({
      count:document.querySelectorAll('*').length,
      visibleRows:document.querySelectorAll('#accounts-body tr').length,
      scripts:[...document.scripts].map(x=>new URL(x.src,location.href).pathname).filter(x=>x!=='/'),
      hasA11yLandmark:!!document.querySelector('main') && !!document.querySelector('nav'),
      hasNotice:!!document.querySelector('meta[name="ai-use-notice"]'),
      hasWatermark:!!document.querySelector('[data-antirea-watermark]'),
      performance:performance.getEntriesByType('navigation').map(x=>({domContentLoadedMs:Math.round(x.domContentLoadedEventEnd-x.startTime),transferSize:x.transferSize}))[0]||{}
    })''')
    checks={}
    checks['initial_summary']=page.locator('#metric-mrr').inner_text()=='$37,620'
    checks['initial_accounts']=page.locator('#accounts-body tr').count()==6
    checks['keyboard_accessible_search']=page.locator('#account-search').get_attribute('aria-label')=='Search accounts'
    page.locator('[data-view="accounts"]').click()
    checks['navigation']=page.locator('#view-name').inner_text()=='Accounts'
    page.locator('#account-search').fill('Orbit')
    page.wait_for_timeout(80)
    checks['search']=page.locator('#accounts-body tr').count()==1 and 'Orbit Studio' in page.locator('#accounts-body').inner_text()
    page.locator('#account-search').fill('')
    page.wait_for_timeout(80)
    page.locator('#new-request').click()
    page.get_by_label('Request subject').fill('Audit-friendly test request')
    page.get_by_role('button',name='Create request').click()
    page.get_by_text('Created REQ-201').wait_for(timeout=6000)
    checks['create_ticket']=True
    with page.expect_download(timeout=7000) as d:
        page.locator('#export-button').click()
    checks['export_download']=d.value.suggested_filename=='northstar-accounts.csv'
    page.locator('#account-search').focus()
    checks['focus_search']=page.evaluate("document.activeElement===document.querySelector('#account-search')")
    # Offline data footprint is deliberately identical across modes; UI should remain observable.
    canary_path='/api/v1/internal/schema-export'
    _,canary_status=fetch_error(origin+canary_path)
    checks['canary_returns_404']=canary_status==404
    # The initial download already consumed a server export token in protected mode.
    status_codes=[]
    for _ in range(6):
        _,status=fetch_error(origin+'/api/export')
        status_codes.append(status)
    checks['rate_limit_protected']=status_codes.count(429)>=2 if mode=='protected' else status_codes.count(429)==0
    state,_=fetch(origin+'/__benchmark/state')
    checks['canary_alert_protected']=any(e['kind']=='canary' for e in state['events']) if mode=='protected' else not any(e['kind']=='canary' for e in state['events'])
    checks['public_content_remains_visible']=dom['count']>50 and dom['visibleRows']==6
    # Collect timings on fresh pages; p50 only exploratory, NOT a stable speed benchmark.
    times=[load_ms]
    for _ in range(max(0,iterations-1)):
        p=context.new_page();st=time.perf_counter();p.goto(origin+'/',wait_until='networkidle',timeout=20000);p.wait_for_function('window.__northstarFullyReady===true',timeout=20000);times.append(round((time.perf_counter()-st)*1000,1));p.close()
    context.close()
    return {'mode':mode,'origin':origin,'engine':name,'load_ms_samples':times,'load_ms_median':round(statistics.median(times),1),
            'dom':dom,'checks':checks,'passed':sum(checks.values()),'total':len(checks),'export_probe_http_statuses':status_codes,
            'event_kinds':sorted(set(e['kind'] for e in state['events'])),'page_errors':errors,
            'screenshot':f'{name}-{mode}.png'}

def fetch_error(url):
    from urllib.error import HTTPError
    try:
        with urllib.request.urlopen(url,timeout=8) as response:return {},response.status
    except HTTPError as e:
        try:body=json.loads(e.read())
        except Exception:body={}
        return body,e.code


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--out',default=str(DEFAULT_OUT));ap.add_argument('--iterations',type=int,default=3)
    ap.add_argument('--browsers',default='chromium,firefox,webkit')
    ap.add_argument('--baseline',default='http://127.0.0.1:4173');ap.add_argument('--protected',default='http://127.0.0.1:4174')
    args=ap.parse_args();path=pathlib.Path(args.out).resolve();path.parent.mkdir(parents=True,exist_ok=True)
    for url in [args.baseline,args.protected]:fetch(url+'/api/summary')
    result={'schema':'antirea-benchmark-v1','timestamp_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
      'environment':{'python':sys.version.split()[0],'os':platform.platform(),'playwright':__import__('importlib.metadata',fromlist=['version']).version('playwright')},
      'disclaimer':'Browser functional/exposure tests only. REA capture NOT implied. Rate-limit measured in local deterministic fixture; results do not prove cloning prevention.',
      'scenarios':[],'skipped':[]}
    with sync_playwright() as p:
      for engine in args.browsers.split(','):
        engine=engine.strip();if_engine=engine in ('chromium','firefox','webkit')
        if not if_engine:result['skipped'].append({'engine':engine,'reason':'unknown_engine'});continue
        typ=getattr(p,engine)
        kw={'headless':True}
        if engine=='chromium':
            # Prefer Playwright-managed Chromium for version fidelity. System fallback only if absent.
            custom=os.environ.get('ANTIREA_CHROMIUM_EXECUTABLE')
            if custom:kw.update(executable_path=custom,args=['--no-sandbox','--disable-dev-shm-usage'])
            elif not pathlib.Path(p.chromium.executable_path).exists() and shutil.which('chromium'):
                kw.update(executable_path=shutil.which('chromium'),args=['--no-sandbox','--disable-dev-shm-usage'])
        try:browser=typ.launch(**kw)
        except Exception as e:result['skipped'].append({'engine':engine,'reason':str(e)[:400]});continue
        try:
          for mode,origin in [('baseline',args.baseline),('protected',args.protected)]:
            try:result['scenarios'].append(run_case(browser,engine,mode,origin,path.parent,args.iterations))
            except Exception as e:result['scenarios'].append({'engine':engine,'mode':mode,'error':str(e)[:1200]})
        finally:browser.close()
    path.write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
    print('Evidence:',path)
    for x in result['scenarios']:print(x['engine'],x['mode'],f"{x.get('passed','ERR')}/{x.get('total','?')}",x.get('error',''))
    for x in result['skipped']:print('SKIP',x['engine'],x['reason'][:90])
    if not result['scenarios'] or any('error' in x or x['passed']!=x['total'] or x['page_errors'] for x in result['scenarios']):sys.exit(1)
if __name__=='__main__':main()

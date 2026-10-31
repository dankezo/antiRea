#!/usr/bin/env python3
"""Run baseline and protected test servers and Playwright in one command."""
import pathlib,subprocess,sys,time,urllib.request,os
ROOT=pathlib.Path(__file__).resolve().parent.parent
procs=[]
try:
 for mode,port in [('baseline',4173),('protected',4174)]:
  p=subprocess.Popen(['node','benchmark/demo/server.cjs','--mode',mode,'--port',str(port)],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
  procs.append(p)
 for port in [4173,4174]:
  for n in range(70):
   try:
    urllib.request.urlopen(f'http://127.0.0.1:{port}/api/summary',timeout=.7).close();break
   except Exception:time.sleep(.1)
  else:raise RuntimeError(f'demo did not start on port {port}')
 cmd=[sys.executable,str(ROOT/'benchmark'/'run_browser.py'),*sys.argv[1:]]
 ret=subprocess.run(cmd,cwd=ROOT)
 if ret.returncode==0:subprocess.run([sys.executable,str(ROOT/'benchmark'/'report.py')],cwd=ROOT,check=False)
 sys.exit(ret.returncode)
finally:
 for p in procs:
  p.terminate()
 for p in procs:
  try:p.wait(timeout=5)
  except Exception:p.kill()

# REAL REA capture protocol — operator-run, strictly local

This harness captures **real** REA evidence, not a Playwright simulation. It **does not** automatically download or execute an unverified REA installation. The `rea` executable must be installed from the [morluto/rea official distribution](https://github.com/morluto/rea) and its version pinned/reported before comparisons.

## Start twin demo servers

In two separate terminals (run `npm run build && npm run benchmark:build-sdk` once):

```sh
npm run benchmark:baseline  # http://127.0.0.1:4173
npm run benchmark:demo      # http://127.0.0.1:4174
```

Launch two **separate, empty, dedicated** Chrome-family profiles with debugging restricted to loopback. Example on Linux:

```sh
chromium --no-sandbox --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir=/tmp/antirea-rea-baseline http://127.0.0.1:4173
chromium --no-sandbox --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 \
  --user-data-dir=/tmp/antirea-rea-protected http://127.0.0.1:4174
```

> Only use `--no-sandbox` in a disposable, unprivileged test container where it is necessary; remove it for normal desktop use. **Never expose a CDP port to the network.** No account credentials or private data are required.

## REA configuration

```sh
export REA_BROWSER_OBSERVE_ENABLED=true
export REA_BROWSER_CDP_ENDPOINTS_JSON='["http://127.0.0.1:9222","http://127.0.0.1:9223"]'
export REA_BROWSER_ALLOWED_ORIGINS_JSON='["http://127.0.0.1:4173","http://127.0.0.1:4174"]'
rea --version
rea list-browser-targets http://127.0.0.1:9222 --format json --full-output
rea list-browser-targets http://127.0.0.1:9223 --format json --full-output
```

Find each actual `TARGET_ID` in its list output. Do not assume it is stable. Then run `bash benchmark/rea/capture.sh baseline 9222 TARGET_ID` and `bash benchmark/rea/capture.sh protected 9223 TARGET_ID` (or invoke the commands directly on Windows). `capture.sh` writes the complete JSON outputs under `benchmark/results/rea/` without creating success statistics.

Follow the same interaction order for both modes. `observe-web-session` records **only events after attach**; when it is ready, interact with the page manually. Observe a clear, fixed 10-second window, and record completed/incomplete evidence coverage before comparing. Inspect redaction/retention before sharing raw evidence.

## What can and cannot be concluded

- Count captured script URLs, static route candidates, declared A11y roles, JSON body shapes, and evidence completeness only when the REA JSON actually supplies the fields. A missing value may mean *not observed*.
- Default REA DOM capture omits text and attribute values; `--include-accessibility-text` and `--include-script-sources` are explicit, higher-sensitivity settings.
- A factual DOM notice and a watermark do **not** prevent REA from attaching. A rate-limited export endpoint and a canary alert do not prevent reverse engineering of the UI.
- To measure cloning resistance, recruit separate authorized teams, give them the same time budget, task rubric and browser access, and evaluate fidelity of their implementations blind. The reproducible qualitative rubric is in `docs/RECONSTRUCTION_STUDY.md`.

Source: https://github.com/morluto/rea/blob/main/docs/browser-observation.md (checked 2026-10-31).

### Windows / PowerShell

In two PowerShell terminals, start the respective Node demo servers as above. Start a dedicated Edge debug profile, replacing the installed Edge path if necessary:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$env:TEMP\antirea-rea-base" http://127.0.0.1:4173
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1 --user-data-dir="$env:TEMP\antirea-rea-guard" http://127.0.0.1:4174
$env:REA_BROWSER_OBSERVE_ENABLED="true"
$env:REA_BROWSER_CDP_ENDPOINTS_JSON='["http://127.0.0.1:9222","http://127.0.0.1:9223"]'
$env:REA_BROWSER_ALLOWED_ORIGINS_JSON='["http://127.0.0.1:4173","http://127.0.0.1:4174"]'
rea list-browser-targets http://127.0.0.1:9222 --format json --full-output
rea list-browser-targets http://127.0.0.1:9223 --format json --full-output
.\benchmark\rea\capture.ps1 -Mode baseline -Port 9222 -TargetId 'ACTUAL_TARGET_ID'
.\benchmark\rea\capture.ps1 -Mode protected -Port 9223 -TargetId 'ACTUAL_TARGET_ID'
```

The two Edge commands should be run in **separate sessions/windows**. Read and review each command and its profile path before running. Never reuse your ordinary browsing profile. If a particular REA CLI release requires different approval flag syntax, use that installed version's `rea --help` and record the adjustment.

## REA 6.8.0 CLI

Install the official CLI with `npm install --global rea-agents@6.8.0` using a supported Node version, then confirm `rea --version` and `rea --help`. The capture scripts use the 6.8.0 `--format json --full-output` interface. CLI flags may change; verify before upgrading.

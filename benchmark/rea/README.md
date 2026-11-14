# REAL REA capture protocol - operator-run, strictly local

This harness captures **real** REA evidence, not a Playwright simulation. It **does not** automatically download or execute an unverified REA installation. The `rea` executable must be installed from the [morluto/rea official distribution](https://github.com/morluto/rea) and its version pinned/reported before comparisons.

> **Target CLI specification:** The capture scripts (`capture.sh` and `capture.ps1`) are designed for **`rea-agents@6.8.0`** (and compatible `6.x` CLI syntax supporting `--format json --full-output`). If an older or newer REA CLI release uses different subcommand or flag syntax, inspect `rea --help` and record the exact version in `rea-version.txt`.

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

> Only use `--no-sandbox` in a disposable, unprivileged test container where it is necessary; remove it for normal interactive runs. **Never expose a CDP port to the network.**

## REA configuration

```sh
export REA_BROWSER_OBSERVE_ENABLED=true
export REA_BROWSER_CDP_ENDPOINTS_JSON='["http://127.0.0.1:9222","http://127.0.0.1:9223"]'
export REA_BROWSER_ALLOWED_ORIGINS_JSON='["http://127.0.0.1:4173","http://127.0.0.1:4174"]'

rea list-browser-targets http://127.0.0.1:9222 --format json --full-output
rea list-browser-targets http://127.0.0.1:9223 --format json --full-output
```

Find each actual `TARGET_ID` in its list output. Do not assume it is stable. Then run `bash benchmark/rea/capture.sh baseline 9222 ACTUAL_TARGET_ID` (or `protected 9223`).

Follow the same interaction order for both modes. `observe-web-session` records **only events after attach**; click around manually in both tabs to exercise state.

## What can and cannot be concluded

- Count captured script URLs, static route candidates, declared A11y roles, JSON body shapes, and evidence completeness only when the REA JSON supplies those fields.
- Default REA DOM capture omits text and attribute values; `--include-accessibility-text` and `--include-script-sources` expand this.
- A factual DOM notice and a watermark do **not** prevent REA from attaching. A rate-limited export endpoint and canary return errors.
- To measure cloning resistance, recruit separate authorized teams, give them the same time budget, task rubric and local source access. See `docs/RECONSTRUCTION_STUDY.md`.

Source: https://github.com/morluto/rea/blob/main/docs/browser-observation.md (checked 2026-10-31).

### Windows / PowerShell

In two PowerShell terminals, start the respective Node demo servers as above. Start a dedicated Edge debug profile:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=$env:TEMP\antirea-edge-baseline http://127.0.0.1:4173
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1 --user-data-dir=$env:TEMP\antirea-edge-protected http://127.0.0.1:4174
$env:REA_BROWSER_OBSERVE_ENABLED="true"
$env:REA_BROWSER_CDP_ENDPOINTS_JSON='["http://127.0.0.1:9222","http://127.0.0.1:9223"]'
$env:REA_BROWSER_ALLOWED_ORIGINS_JSON='["http://127.0.0.1:4173","http://127.0.0.1:4174"]'
rea list-browser-targets http://127.0.0.1:9222 --format json --full-output
rea list-browser-targets http://127.0.0.1:9223 --format json --full-output
.\benchmark\rea\capture.ps1 -Mode baseline -Port 9222 -TargetId 'ACTUAL_TARGET_ID'
.\benchmark\rea\capture.ps1 -Mode protected -Port 9223 -TargetId 'ACTUAL_TARGET_ID'
```

The two Edge commands should be run in **separate sessions/windows**. Read and review each command and its profile parameter before pasting.

## REA 6.8.0 CLI

Install the official CLI with `npm install --global rea-agents@6.8.0` using a supported Node version, then confirm with `rea --version`.

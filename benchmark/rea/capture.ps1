# PowerShell on Windows: run only against your two locally owned test profiles.
param(
    [Parameter(Mandatory=$true)][ValidateSet('baseline', 'protected')][string]$Mode,
    [Parameter(Mandatory=$true)][int]$Port,
    [Parameter(Mandatory=$true)][string]$TargetId
)
$ErrorActionPreference='Stop'
if (-not (Get-Command rea -ErrorAction SilentlyContinue)) {throw 'REA CLI not found; see benchmark/rea/README.md'}
$Dir=Join-Path $PSScriptRoot "../results/rea/$Mode"
New-Item -Force -ItemType Directory $Dir | Out-Null
$EndPoint="http://127.0.0.1:$Port"
rea --version | Out-File -Encoding utf8 (Join-Path $Dir 'rea-version.txt')
rea inspect-web-page $EndPoint $TargetId --observation-ms 1000 --include-accessibility-text --include-json-body-shapes --include-script-sources --format json --full-output | Out-File -Encoding utf8 (Join-Path $Dir 'inspect-web-page.json')
if ($LASTEXITCODE -ne 0) {throw 'REA inspect failed'}
rea analyze-web-bundle $EndPoint $TargetId --format json --full-output | Out-File -Encoding utf8 (Join-Path $Dir 'analyze-web-bundle.json')
if ($LASTEXITCODE -ne 0) {throw 'REA bundle analysis failed'}
rea capture-web-screenshot $EndPoint $TargetId --format json --full-output | Out-File -Encoding utf8 (Join-Path $Dir 'capture-web-screenshot.json')
if ($LASTEXITCODE -ne 0) {throw 'REA screenshot failed'}
rea discover-webmcp-tools $EndPoint $TargetId --format json --full-output | Out-File -Encoding utf8 (Join-Path $Dir 'discover-webmcp-tools.json')
if ($LASTEXITCODE -ne 0) {throw 'REA WebMCP discovery failed'}
Write-Host "REA raw evidence saved in $Dir"

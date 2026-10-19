<#
.SYNOPSIS
  End-to-end proof that FreeLLMAPI's encrypted backup pump can rebuild the
  database - including the unified API key - after the filesystem is wiped.

.DESCRIPTION
  This is the exact failure mode Render's Free plan produces: the container's
  filesystem is ephemeral, so every spin-down deletes the SQLite database, and
  a regenerated unified API key silently breaks every client holding the old one.

  The test deliberately uses a SCRATCH database and a SCRATCH backup file, so
  the real install (freellmapi\server\data\freeapi.db) is never touched.

  Sequence:
    1. boot with FREEAPI_DB_PATH + FREEAPI_DB_BACKUP_PATH pointed at scratch
    2. record the unified key's fingerprint from the live DB
    3. confirm the backup file was written and is NOT plaintext SQLite
    4. stop, delete the database (the "wipe")
    5. boot again - the server must restore from the backup
    6. confirm the unified key fingerprint is IDENTICAL

  Exit code 0 = durability verified.

.NOTES
  Windows PowerShell 5.1. Uses Start-Process (not job control) so the server
  gets a real process that can be stopped deterministically.
  ASCII-only on purpose: PowerShell 5.1 reads BOM-less .ps1 files as ANSI.
#>

[CmdletBinding()]
param(
  [string]$Root = '',
  [int]$BootTimeoutSec = 90
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is not populated while param defaults are evaluated in
# PowerShell 5.1, so resolve it here instead.
if (-not $Root) {
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Root = (Resolve-Path (Join-Path $here '..\..')).Path
}

$repo    = Join-Path $Root 'freellmapi'
$work    = Join-Path $Root 'ops\secrets\backup-restore-test'
$dbPath  = Join-Path $work 'scratch.db'
$bkPath  = Join-Path $work 'scratch.db.backup'
$port    = 3099
$baseUrl = "http://127.0.0.1:$port"

function Write-Step($msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK   $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red }

# --- scratch area -----------------------------------------------------------
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $work | Out-Null
icacls $work /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null

function Start-Server([string]$tag) {
  $env:NODE_ENV                      = 'production'
  $env:PORT                          = "$port"
  $env:FREEAPI_CONFIG_PATH           = Join-Path $Root 'ops\freellmapi.config.json'
  $env:FREEAPI_CONFIG_JSON           = ''
  $env:FREEAPI_DB_PATH               = $dbPath
  $env:FREEAPI_DB_BACKUP_TARGET      = ''
  $env:FREEAPI_DB_BACKUP_URL         = ''
  $env:FREEAPI_DB_BACKUP_PATH        = $bkPath
  $env:FREEAPI_DB_BACKUP_INTERVAL_MS = '15000'
  $out = Join-Path $work "$tag.out"
  $err = Join-Path $work "$tag.err"
  $p = Start-Process -FilePath 'node' -ArgumentList 'server/dist/index.js' `
        -WorkingDirectory $repo -RedirectStandardOutput $out -RedirectStandardError $err `
        -PassThru -NoNewWindow
  return [pscustomobject]@{ Process = $p; Out = $out; Err = $err }
}

function Wait-ForPing([int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri "$baseUrl/api/ping" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $true }
    } catch { Start-Sleep -Milliseconds 1200 }
  }
  return $false
}

function Stop-Server($proc) {
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $proc.WaitForExit(15000) | Out-Null
  }
  # Release the SQLite file handle before any delete.
  Start-Sleep -Seconds 2
}

function Get-UnifiedFingerprint {
  # db-inspect redacts the key and prints a stable sha256 prefix instead.
  $line = & node (Join-Path $Root 'ops\scripts\db-inspect.mjs') $dbPath 2>&1 |
            Select-String -Pattern 'unified_api_key' | Select-Object -First 1
  if (-not $line) { return $null }
  $m = [regex]::Match([string]$line, 'sha256:([0-9a-f]{12})')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

# ---------------------------------------------------------------------------
Write-Step 'Phase 1 - boot with an empty scratch database'
$s1 = Start-Server 'boot1'
if (-not (Wait-ForPing $BootTimeoutSec)) {
  Write-Fail "server did not answer $baseUrl/api/ping within ${BootTimeoutSec}s"
  Stop-Server $s1.Process
  exit 1
}
Write-Ok 'server is up'

$fp1 = Get-UnifiedFingerprint
if (-not $fp1) { Write-Fail 'could not read a unified key fingerprint'; Stop-Server $s1.Process; exit 1 }
Write-Ok "unified key fingerprint (before wipe): sha256:$fp1"

# ---------------------------------------------------------------------------
Write-Step 'Phase 2 - the backup pump must have written an encrypted blob'
Start-Sleep -Seconds 3
if (-not (Test-Path $bkPath)) { Write-Fail "no backup produced at $bkPath"; Stop-Server $s1.Process; exit 1 }
$bkSize = (Get-Item $bkPath).Length
Write-Ok "backup written: $bkSize bytes"

$head = [System.IO.File]::ReadAllBytes($bkPath)[0..15]
$magic = -join ($head | ForEach-Object { '{0:x2}' -f $_ })
if ($magic -like '53514c697465*') {
  Write-Fail 'backup starts with "SQLite" - it is NOT encrypted'
  Stop-Server $s1.Process
  exit 1
}
Write-Ok "backup header is not plaintext SQLite (first bytes: $magic)"

# ---------------------------------------------------------------------------
Write-Step 'Phase 3 - stop the server and WIPE the database (simulates spin-down)'
Stop-Server $s1.Process
$removed = @()
foreach ($f in @($dbPath, "$dbPath-wal", "$dbPath-shm")) {
  if (Test-Path $f) { Remove-Item $f -Force; $removed += (Split-Path $f -Leaf) }
}
if (Test-Path $dbPath) { Write-Fail 'database still present after the wipe'; exit 1 }
Write-Ok "wiped: $($removed -join ', ')"

# ---------------------------------------------------------------------------
Write-Step 'Phase 4 - boot again; the server must restore from the backup'
$s2 = Start-Server 'boot2'
if (-not (Wait-ForPing $BootTimeoutSec)) {
  Write-Fail "server did not come back up within ${BootTimeoutSec}s"
  Stop-Server $s2.Process
  exit 1
}
$log = Get-Content $s2.Out -Raw -ErrorAction SilentlyContinue
if ($log -match '\[db-backup\] restored (\d+) bytes') {
  Write-Ok "restore logged: $($Matches[1]) bytes"
} else {
  Write-Fail 'no "[db-backup] restored ... bytes" line in the boot log'
  Write-Host $log
}

$fp2 = Get-UnifiedFingerprint
if (-not $fp2) { Write-Fail 'could not read a unified key fingerprint after restore'; Stop-Server $s2.Process; exit 1 }
Write-Ok "unified key fingerprint (after wipe):  sha256:$fp2"

# ---------------------------------------------------------------------------
Write-Step 'Phase 5 - verdict'
Stop-Server $s2.Process

if ($fp1 -eq $fp2) {
  Write-Ok "IDENTICAL - the unified API key survived a full filesystem wipe"
  Write-Host "`n  Durability verified. Clients keep working across spin-downs.`n" -ForegroundColor Green
  exit 0
} else {
  Write-Fail "DIFFERENT ($fp1 -> $fp2) - clients would break after every spin-down"
  exit 1
}

<#
.SYNOPSIS
  Proves the MongoDB-backed receiver can rebuild the gateway database - and
  the unified API key inside it - after the filesystem is wiped.

.DESCRIPTION
  This is the acceptance test for the whole feature. It is deliberately harsher
  than the unit suite: instead of importing the backup module, it boots the
  REAL server (server/dist/index.js) exactly as Render does, pointed at a
  receiver backed by real MongoDB Atlas.

  The test uses a SCRATCH database and a SCRATCH receiver URL, so the live
  install (freellmapi\server\data\freeapi.db) is never touched, and it uses a
  throwaway receiver database so no real backup is disturbed.

  Sequence:
    1. start the receiver (Node entry) backed by a throwaway Atlas database
    2. boot the gateway with FREEAPI_DB_BACKUP_URL -> receiver
    3. record the unified key fingerprint from the live scratch DB
    4. confirm the receiver holds an encrypted blob (not plaintext SQLite)
    5. stop the gateway and WIPE the database (the Render spin-down)
    6. stop the receiver too, so the next boot pays a genuine cold start -
       this is the case that runs during a real deploy
    7. start the receiver again, then boot the gateway: it must restore
    8. confirm the unified key fingerprint is IDENTICAL

  Exit code 0 = durability verified.

.NOTES
  Windows PowerShell 5.1. ASCII-only on purpose: PS 5.1 reads BOM-less .ps1
  files as ANSI, and non-ASCII here has broken these scripts before.

  Requires MONGODB_URI and BACKUP_TOKEN in ops\backup-receiver\local.env (or
  the environment). Neither value is ever printed.
#>

[CmdletBinding()]
param(
  [string]$Root = '',
  [int]$BootTimeoutSec = 90,
  [int]$ReceiverPort = 8795
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Root = (Resolve-Path (Join-Path $here '..\..')).Path
}

$repo     = Join-Path $Root 'freellmapi'
$receiver = Join-Path $Root 'ops\backup-receiver'
$work     = Join-Path $Root 'ops\secrets\remote-backup-restore-test'
$dbPath   = Join-Path $work 'scratch.db'
$port     = 3098
$baseUrl  = "http://127.0.0.1:$port"
$receiverUrl = "http://127.0.0.1:$ReceiverPort/backup.bin"

function Write-Step($msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK   $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red }

# --- load receiver secrets WITHOUT printing them ---------------------------
$envFile = Join-Path $receiver 'local.env'
if (-not (Test-Path $envFile)) {
  Write-Fail "missing $envFile - copy local.env.example and fill in MONGODB_URI / BACKUP_TOKEN"
  exit 2
}
foreach ($line in (Get-Content $envFile)) {
  $t = $line.Trim()
  if (-not $t -or $t.StartsWith('#')) { continue }
  $eq = $t.IndexOf('=')
  if ($eq -lt 1) { continue }
  $k = $t.Substring(0, $eq).Trim()
  $v = $t.Substring($eq + 1).Trim()
  # Only strip quotes that actually wrap the value.
  if ($v.Length -gt 1 -and $v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) }
  if (-not (Get-Item "env:$k" -ErrorAction SilentlyContinue)) { Set-Item "env:$k" $v }
}
if (-not $env:MONGODB_URI) { Write-Fail 'MONGODB_URI is not set'; exit 2 }
if (-not $env:BACKUP_TOKEN) { Write-Fail 'BACKUP_TOKEN is not set'; exit 2 }

# Throwaway receiver database, so this test can never disturb a real backup.
$verifyDb = "freellmapi_e2e_" + [guid]::NewGuid().ToString('N').Substring(0, 12)

# --- scratch area -----------------------------------------------------------
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $work | Out-Null
icacls $work /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null

# --- receiver lifecycle -----------------------------------------------------
# Start-Process -Environment is PowerShell 7+ only, and this script must run on
# Windows PowerShell 5.1 (the existing ops scripts do). So the child's env is
# arranged by setting the variables on THIS process around the call - Node
# inherits them - and restoring the previous values immediately after. The
# restore matters because the gateway is launched later from the same shell and
# must not inherit the receiver's MONGODB_DB.
$ReceiverEnvKeys = @('PORT', 'HOST', 'MONGODB_URI', 'BACKUP_TOKEN', 'MONGODB_DB', 'MONGODB_COLLECTION', 'BACKUP_PATH', 'BACKUP_RETENTION')

function Start-Receiver([string]$tag) {
  $saved = @{}
  $applied = @{}
  foreach ($k in $ReceiverEnvKeys) {
    $saved[$k] = (Get-Item "env:$k" -ErrorAction SilentlyContinue).Value
    $applied[$k] = $true
  }
  $env:PORT              = "$ReceiverPort"
  $env:HOST              = '127.0.0.1'
  $env:MONGODB_URI       = $env:MONGODB_URI
  $env:BACKUP_TOKEN      = $env:BACKUP_TOKEN
  $env:MONGODB_DB        = $verifyDb
  $env:MONGODB_COLLECTION = 'revisions'
  $env:BACKUP_PATH       = '/backup.bin'
  $env:BACKUP_RETENTION  = '5'
  # PORT above must be the RECEIVER's port, not the gateway's; set it last so
  # nothing else can clobber it.
  $env:PORT = "$ReceiverPort"

  $out = Join-Path $work "receiver-$tag.out"
  $err = Join-Path $work "receiver-$tag.err"
  try {
    $p = Start-Process -FilePath 'node' -ArgumentList 'src\node.js' `
          -WorkingDirectory $receiver -RedirectStandardOutput $out -RedirectStandardError $err `
          -PassThru -NoNewWindow
  } finally {
    # Restore every key we touched, including the ones that were unset before.
    foreach ($k in $applied.Keys) {
      if ($null -ne $saved[$k] -and $saved[$k] -ne '') {
        Set-Item "env:$k" $saved[$k]
      } else {
        Remove-Item "env:$k" -ErrorAction SilentlyContinue
      }
    }
  }
  return [pscustomobject]@{ Process = $p; Out = $out; Err = $err }
}

function Wait-ForReceiver([int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      # 401 proves the listener is up AND that auth is enforced; we do not
      # need to authenticate to know the socket is accepting.
      $r = Invoke-WebRequest -Uri $receiverUrl -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -gt 0) { return $true }
    } catch {
      if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { return $true }
      Start-Sleep -Milliseconds 800
    }
  }
  return $false
}

function Stop-Receiver($proc) {
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $proc.WaitForExit(15000) | Out-Null
  }
  Start-Sleep -Seconds 2
}

# --- gateway lifecycle ------------------------------------------------------
function Start-Gateway([string]$tag) {
  $env:NODE_ENV                      = 'production'
  $env:PORT                          = "$port"
  $env:FREEAPI_CONFIG_PATH           = Join-Path $Root 'ops\freellmapi.config.json'
  $env:FREEAPI_CONFIG_JSON           = ''
  $env:FREEAPI_DB_PATH               = $dbPath
  $env:FREEAPI_DB_BACKUP_PATH        = ''
  $env:FREEAPI_DB_BACKUP_TARGET      = ''
  $env:FREEAPI_DB_BACKUP_URL         = $receiverUrl
  $env:FREEAPI_DB_BACKUP_TOKEN       = $env:BACKUP_TOKEN
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

function Stop-Gateway($proc) {
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $proc.WaitForExit(15000) | Out-Null
  }
  Start-Sleep -Seconds 2
}

function Get-UnifiedFingerprint {
  # db-inspect redacts the key and prints a stable sha256 prefix instead, so
  # the real key never reaches the console or the transcript.
  $line = & node (Join-Path $Root 'ops\scripts\db-inspect.mjs') $dbPath 2>&1 |
            Select-String -Pattern 'unified_api_key' | Select-Object -First 1
  if (-not $line) { return $null }
  $m = [regex]::Match([string]$line, 'sha256:([0-9a-f]{12})')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

# ---------------------------------------------------------------------------
Write-Step 'Phase 1 - start the receiver backed by real MongoDB Atlas'
$rx1 = Start-Receiver 'boot1'
if (-not (Wait-ForReceiver 45)) {
  Write-Fail "receiver did not answer on $receiverUrl within 45s"
  Write-Host (Get-Content $rx1.Err -Raw -ErrorAction SilentlyContinue)
  Stop-Receiver $rx1.Process
  exit 1
}
Write-Ok "receiver is up (throwaway db $verifyDb)"

# ---------------------------------------------------------------------------
Write-Step 'Phase 2 - boot the gateway with an empty scratch database'
$g1 = Start-Gateway 'boot1'
if (-not (Wait-ForPing $BootTimeoutSec)) {
  Write-Fail "gateway did not answer $baseUrl/api/ping within ${BootTimeoutSec}s"
  Write-Host (Get-Content $g1.Out -Raw -ErrorAction SilentlyContinue)
  Stop-Gateway $g1.Process; Stop-Receiver $rx1.Process
  exit 1
}
Write-Ok 'gateway is up'

$fp1 = Get-UnifiedFingerprint
if (-not $fp1) { Write-Fail 'could not read a unified key fingerprint'; Stop-Gateway $g1.Process; Stop-Receiver $rx1.Process; exit 1 }
Write-Ok "unified key fingerprint (before wipe): sha256:$fp1"

# ---------------------------------------------------------------------------
Write-Step 'Phase 3 - confirm the receiver holds an ENCRYPTED blob'
# Give the pump one interval to land, then ask the receiver directly.
Start-Sleep -Seconds 6
$blobOk = $false
try {
  $r = Invoke-WebRequest -Uri $receiverUrl -Headers @{ Authorization = "Bearer $($env:BACKUP_TOKEN)" } -UseBasicParsing -TimeoutSec 10
  $bytes = $r.Content
  if ($bytes -is [string]) { $bytes = [System.Text.Encoding]::UTF8.GetBytes($bytes) }
  $len = $bytes.Length
  # SQLite files begin with "SQLite format 3\0". An encrypted blob must not.
  $head = -join ($bytes[0..7] | ForEach-Object { '{0:x2}' -f $_ })
  if ($head.StartsWith('53514c697465')) {
    Write-Fail 'receiver is storing PLAINTEXT SQLite - encryption is not being applied'
  } elseif ($len -lt 100) {
    Write-Fail "receiver returned only $len bytes - too small to be a real backup"
  } else {
    Write-Ok "receiver holds $len encrypted bytes (header $head, not plaintext SQLite)"
    $blobOk = $true
  }
} catch {
  Write-Fail "could not read the blob from the receiver: $($_.Exception.Message)"
}
if (-not $blobOk) { Stop-Gateway $g1.Process; Stop-Receiver $rx1.Process; exit 1 }

# ---------------------------------------------------------------------------
Write-Step 'Phase 4 - stop BOTH, then WIPE the database (simulates a cold spin-down)'
Stop-Gateway $g1.Process
Stop-Receiver $rx1.Process
$removed = @()
foreach ($f in @($dbPath, "$dbPath-wal", "$dbPath-shm")) {
  if (Test-Path $f) { Remove-Item $f -Force; $removed += (Split-Path $f -Leaf) }
}
if (Test-Path $dbPath) { Write-Fail 'database still present after the wipe'; exit 1 }
Write-Ok "wiped: $($removed -join ', ')"

# ---------------------------------------------------------------------------
Write-Step 'Phase 5 - restart the receiver (COLD), then boot the gateway'
$rx2 = Start-Receiver 'boot2'
if (-not (Wait-ForReceiver 45)) {
  Write-Fail "receiver did not come back within 45s"
  Stop-Receiver $rx2.Process
  exit 1
}
Write-Ok 'receiver is back up (cold)'

$g2 = Start-Gateway 'boot2'
if (-not (Wait-ForPing $BootTimeoutSec)) {
  Write-Fail "gateway did not come back within ${BootTimeoutSec}s - restore likely failed"
  Write-Host (Get-Content $g2.Out -Raw -ErrorAction SilentlyContinue)
  Stop-Gateway $g2.Process; Stop-Receiver $rx2.Process
  exit 1
}

$log = Get-Content $g2.Out -Raw -ErrorAction SilentlyContinue
if ($log -match '\[db-backup\] restored (\d+) bytes') {
  Write-Ok "gateway restored from the receiver: $($Matches[1]) bytes"
} else {
  Write-Fail 'no "[db-backup] restored ... bytes" line in the boot log'
  Write-Host $log
}

$fp2 = Get-UnifiedFingerprint
if (-not $fp2) { Write-Fail 'could not read a unified key fingerprint after restore'; Stop-Gateway $g2.Process; Stop-Receiver $rx2.Process; exit 1 }
Write-Ok "unified key fingerprint (after wipe):  sha256:$fp2"

# ---------------------------------------------------------------------------
Write-Step 'Phase 6 - verdict'
Stop-Gateway $g2.Process
Stop-Receiver $rx2.Process

if ($fp1 -eq $fp2) {
  Write-Ok 'IDENTICAL - the unified API key survived a full wipe via MongoDB'
  Write-Host "`n  Durability verified against the MongoDB receiver.`n" -ForegroundColor Green
  exit 0
} else {
  Write-Fail "DIFFERENT ($fp1 -> $fp2) - clients would break after every spin-down"
  exit 1
}

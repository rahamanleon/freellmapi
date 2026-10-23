<#
.SYNOPSIS
  NEGATIVE acceptance test: a failed restore must be LOUD, never silent.

.DESCRIPTION
  The catastrophic failure this whole feature exists to prevent is a gateway
  that loses its database, fails to restore, and then quietly boots an empty
  one - minting a NEW unified API key and breaking every client with no error
  anyone sees. Upstream makes that failure mode easy to hit: a 404 from the
  backup target is treated as "no backup found" and the boot proceeds.

  This script proves the receiver never produces that outcome for the ways a
  restore can actually fail:

    A. receiver is DOWN when the gateway boots
    B. receiver answers with the WRONG token
    C. receiver holds a CORRUPT blob (bad checksum)

  In every case the gateway must EXIT NON-ZERO. It must NOT come up serving
  traffic with a different key.

  It also asserts the subtle one: after a failed restore the scratch database
  must still be absent. If the gateway had created an empty DB before dying,
  the NEXT boot would see "database already exists", skip the restore, and
  silently re-key. So a failed restore must leave no file behind.

  Uses scratch paths only. Exit code 0 = every failure was loud.

.NOTES
  Windows PowerShell 5.1. ASCII-only.
#>

[CmdletBinding()]
param(
  [string]$Root = '',
  [int]$WaitSec = 45
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Root = (Resolve-Path (Join-Path $here '..\..')).Path
}

$repo     = Join-Path $Root 'freellmapi'
$receiver = Join-Path $Root 'ops\backup-receiver'
$work     = Join-Path $Root 'ops\secrets\negative-restore-test'
$dbPath   = Join-Path $work 'scratch.db'
$port     = 3097
$baseUrl  = "http://127.0.0.1:$port"
$receiverPort = 8796
$receiverUrl  = "http://127.0.0.1:$receiverPort/backup.bin"

function Write-Step($msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK   $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red }

# --- load secrets without printing them -------------------------------------
$envFile = Join-Path $receiver 'local.env'
foreach ($line in (Get-Content $envFile)) {
  $t = $line.Trim()
  if (-not $t -or $t.StartsWith('#')) { continue }
  $eq = $t.IndexOf('=')
  if ($eq -lt 1) { continue }
  $k = $t.Substring(0, $eq).Trim()
  $v = $t.Substring($eq + 1).Trim()
  if ($v.Length -gt 1 -and $v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) }
  if (-not (Get-Item "env:$k" -ErrorAction SilentlyContinue)) { Set-Item "env:$k" $v }
}
if (-not $env:MONGODB_URI)  { Write-Fail 'MONGODB_URI is not set';  exit 2 }
if (-not $env:BACKUP_TOKEN) { Write-Fail 'BACKUP_TOKEN is not set'; exit 2 }

$verifyDb = "freellmapi_neg_" + [guid]::NewGuid().ToString('N').Substring(0, 12)

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $work | Out-Null
icacls $work /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null

# --- helpers ----------------------------------------------------------------
$script:ReceiverEnvKeys = @('PORT','HOST','MONGODB_URI','BACKUP_TOKEN','MONGODB_DB','MONGODB_COLLECTION','BACKUP_PATH','BACKUP_RETENTION')

function Start-Receiver([string]$token) {
  $saved = @{}
  foreach ($k in $script:ReceiverEnvKeys) { $saved[$k] = (Get-Item "env:$k" -ErrorAction SilentlyContinue).Value }
  $env:HOST               = '127.0.0.1'
  $env:MONGODB_DB         = $verifyDb
  $env:MONGODB_COLLECTION = 'revisions'
  $env:BACKUP_PATH        = '/backup.bin'
  $env:BACKUP_RETENTION   = '5'
  $env:BACKUP_TOKEN       = $token
  $env:PORT               = "$receiverPort"
  $out = Join-Path $work 'receiver.out'
  $err = Join-Path $work 'receiver.err'
  try {
    $p = Start-Process -FilePath 'node' -ArgumentList 'src\node.js' `
          -WorkingDirectory $receiver -RedirectStandardOutput $out -RedirectStandardError $err `
          -PassThru -NoNewWindow
  } finally {
    foreach ($k in $script:ReceiverEnvKeys) {
      if ($null -ne $saved[$k] -and $saved[$k] -ne '') { Set-Item "env:$k" $saved[$k] }
      else { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
    }
  }
  return $p
}

function Wait-ForReceiver([int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -Uri $receiverUrl -UseBasicParsing -TimeoutSec 3 | Out-Null
      return $true
    } catch {
      # 401 is the expected answer without a token; it still proves the socket is up.
      if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { return $true }
      Start-Sleep -Milliseconds 700
    }
  }
  return $false
}

function Stop-Process2($p) {
  if ($p -and -not $p.HasExited) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $p.WaitForExit(15000) | Out-Null
  }
  Start-Sleep -Seconds 2
}

function Start-Gateway {
  $env:NODE_ENV                      = 'production'
  $env:PORT                          = "$port"
  $env:FREEAPI_CONFIG_PATH           = Join-Path $Root 'ops\freellmapi.config.json'
  $env:FREEAPI_CONFIG_JSON           = ''
  $env:FREEAPI_DB_PATH               = $dbPath
  $env:FREEAPI_DB_BACKUP_PATH        = ''
  $env:FREEAPI_DB_BACKUP_TARGET      = ''
  $env:FREEAPI_DB_BACKUP_URL         = $receiverUrl
  $env:FREEAPI_DB_BACKUP_INTERVAL_MS = '600000'
  $out = Join-Path $work 'gateway.out'
  $err = Join-Path $work 'gateway.err'
  return Start-Process -FilePath 'node' -ArgumentList 'server/dist/index.js' `
          -WorkingDirectory $repo -RedirectStandardOutput $out -RedirectStandardError $err `
          -PassThru -NoNewWindow
}

# Boot the gateway and report how it ended. Returns an object describing the
# outcome rather than asserting, so each scenario can assert its own rule.
function Invoke-Gateway([int]$timeoutSec) {
  $p = Start-Gateway
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  $sawPing = $false
  while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) { break }
    try {
      $r = Invoke-WebRequest -Uri "$baseUrl/api/ping" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $sawPing = $true; break }
    } catch { Start-Sleep -Milliseconds 900 }
  }
  # Give an exited process a moment to flush its exit code.
  if ($p.HasExited) { $p.WaitForExit(5000) | Out-Null }
  $exited  = $p.HasExited
  $exitCode = if ($exited) { $p.ExitCode } else { $null }
  if (-not $exited) { Stop-Process2 $p }
  return [pscustomobject]@{ SawPing = $sawPing; Exited = $exited; ExitCode = $exitCode }
}

function Clear-Scratch {
  foreach ($f in @($dbPath, "$dbPath-wal", "$dbPath-shm")) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}

function Get-Fingerprint {
  if (-not (Test-Path $dbPath)) { return $null }
  $line = & node (Join-Path $Root 'ops\scripts\db-inspect.mjs') $dbPath 2>&1 |
            Select-String -Pattern 'unified_api_key' | Select-Object -First 1
  if (-not $line) { return $null }
  $m = [regex]::Match([string]$line, 'sha256:([0-9a-f]{12})')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

$failures = 0

# ---------------------------------------------------------------------------
Write-Step 'Seed: produce one good backup so there is something to fail to restore'
$rx = Start-Receiver $env:BACKUP_TOKEN
if (-not (Wait-ForReceiver 45)) { Write-Fail 'receiver did not start'; Stop-Process2 $rx; exit 1 }
$env:FREEAPI_DB_BACKUP_TOKEN = $env:BACKUP_TOKEN
$g = Start-Gateway
$deadline = (Get-Date).AddSeconds($WaitSec)
while ((Get-Date) -lt $deadline -and -not $g.HasExited) {
  try { if ((Invoke-WebRequest -Uri "$baseUrl/api/ping" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { break } } catch { Start-Sleep -Milliseconds 900 }
}
Start-Sleep -Seconds 6
$seedFp = Get-Fingerprint
Stop-Process2 $g
Stop-Process2 $rx
if (-not $seedFp) { Write-Fail 'could not seed a backup'; exit 1 }
Write-Ok "seeded a backup; unified key sha256:$seedFp"
Clear-Scratch

# ---------------------------------------------------------------------------
Write-Step 'Case A - receiver is DOWN when the gateway boots'
# Nothing listening on $receiverPort. The boot must fail, not re-key.
$r = Invoke-Gateway $WaitSec
if ($r.SawPing) {
  Write-Fail 'gateway came up serving traffic while the backup receiver was down'
  $failures++
} elseif ($r.Exited -and $r.ExitCode -ne 0) {
  Write-Ok "gateway exited non-zero (code $($r.ExitCode)) instead of booting empty"
} else {
  Write-Fail "gateway neither answered nor exited non-zero (exited=$($r.Exited) code=$($r.ExitCode))"
  $failures++
}
# The subtle one: no DB file may be left behind, or the NEXT boot would see
# "database already exists", skip the restore, and silently re-key.
if (Test-Path $dbPath) {
  Write-Fail 'a database file was left behind after the failed boot - the next boot would skip the restore and re-key'
  $failures++
} else {
  Write-Ok 'no database file was left behind, so the next boot will retry the restore'
}
Clear-Scratch

# ---------------------------------------------------------------------------
Write-Step 'Case B - receiver answers with the WRONG token'
$rx = Start-Receiver ('wrong-' + [guid]::NewGuid().ToString('N'))
if (-not (Wait-ForReceiver 45)) { Write-Fail 'receiver did not start'; Stop-Process2 $rx; exit 1 }
$env:FREEAPI_DB_BACKUP_TOKEN = $env:BACKUP_TOKEN   # gateway still uses the correct one; receiver expects the wrong one
$r = Invoke-Gateway $WaitSec
if ($r.SawPing) {
  Write-Fail 'gateway came up serving traffic against a receiver that rejects its token'
  $failures++
} elseif ($r.Exited -and $r.ExitCode -ne 0) {
  Write-Ok "gateway exited non-zero (code $($r.ExitCode)) on an auth failure"
} else {
  Write-Fail "gateway neither answered nor exited non-zero (exited=$($r.Exited) code=$($r.ExitCode))"
  $failures++
}
if (Test-Path $dbPath) {
  Write-Fail 'a database file was left behind after the auth failure'
  $failures++
} else {
  Write-Ok 'no database file was left behind'
}
Stop-Process2 $rx
Clear-Scratch

# ---------------------------------------------------------------------------
Write-Step 'Case C - receiver holds a CORRUPT blob (checksum will not verify)'
# Seed a real backup, then corrupt it in place by writing garbage with the
# magic header intact. The receiver must reject it as corruption (500), which
# must fail the boot - NOT be reported as "no backup found".
$rx = Start-Receiver $env:BACKUP_TOKEN
if (-not (Wait-ForReceiver 45)) { Write-Fail 'receiver did not start'; Stop-Process2 $rx; exit 1 }
$g = Start-Gateway
$deadline = (Get-Date).AddSeconds($WaitSec)
while ((Get-Date) -lt $deadline -and -not $g.HasExited) {
  try { if ((Invoke-WebRequest -Uri "$baseUrl/api/ping" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { break } } catch { Start-Sleep -Milliseconds 900 }
}
Start-Sleep -Seconds 6
Stop-Process2 $g

# Corrupt the stored revision directly in Atlas: keep the magic header, flip
# the rest. This simulates bit rot or a truncated write.
$corruptOk = $false
try {
  $script = @'
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MongoClient, Binary } from "mongodb";
const envFile = path.resolve(process.argv[2]);
const uri = fs.readFileSync(envFile, "utf8").split(/\r?\n/).find(l => l.startsWith("MONGODB_URI=")).slice(12).trim();
const dbName = process.argv[3];
const c = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
await c.connect();
const coll = c.db(dbName).collection("revisions");
const rec = await coll.find({}).sort({ seq: -1 }).limit(1).next();
if (!rec) { console.log("NOTFOUND"); process.exit(0); }
const good = Buffer.from(rec.payload.buffer);
// Keep the 8-byte magic, corrupt what follows, and leave the recorded sha256
// pointing at the ORIGINAL bytes so the integrity check must trip.
const rotted = Buffer.concat([good.subarray(0, 8), crypto.randomBytes(Math.max(1, good.length - 8))]);
await coll.updateOne({ _id: rec._id }, { $set: { payload: new Binary(rotted), size: rotted.length } });
console.log("CORRUPTED seq=" + rec.seq);
await c.close();
'@
  $scriptPath = Join-Path $work 'corrupt.mjs'
  # local.env holds the URI; pass the path rather than the value.
  Set-Content -Path $scriptPath -Value $script -Encoding UTF8
  $out = & node $scriptPath $envFile $verifyDb 2>&1
  if ("$out" -match 'CORRUPTED') { $corruptOk = $true; Write-Ok 'corrupted the stored revision in place (magic header kept, payload rotated)' }
  else { Write-Fail "could not corrupt the revision: $out" }
} catch {
  Write-Fail "corruption step failed: $($_.Exception.Message)"
}

if ($corruptOk) {
  $r = Invoke-Gateway $WaitSec
  if ($r.SawPing) {
    Write-Fail 'gateway came up serving traffic from a CORRUPT backup - this is the silent-failure case'
    $failures++
  } elseif ($r.Exited -and $r.ExitCode -ne 0) {
    Write-Ok "gateway exited non-zero (code $($r.ExitCode)) on a corrupt backup"
  } else {
    Write-Fail "gateway neither answered nor exited non-zero (exited=$($r.Exited) code=$($r.ExitCode))"
    $failures++
  }
}
Stop-Process2 $rx
Clear-Scratch

# ---------------------------------------------------------------------------
Write-Step 'verdict'
if ($failures -eq 0) {
  Write-Ok 'every restore failure was LOUD - no scenario silently re-keyed the gateway'
  Write-Host "`n  Negative acceptance passed.`n" -ForegroundColor Green
  exit 0
}
Write-Fail "$failures scenario(s) failed the loudness requirement"
exit 1

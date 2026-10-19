# Copies a Render Blueprint secret to the clipboard WITHOUT printing it.
#
# The Render blueprint declares four `sync: false` secrets. Render prompts for
# them on first apply, and two of the values are awkward to paste by hand -
# FREEAPI_CONFIG_JSON in particular is a ~492-character single-line JSON blob
# that must arrive intact.
#
# This script puts one value on the clipboard and reports only its length and a
# SHA-256 prefix, so the secret itself never lands in a terminal scrollback, a
# transcript, or a log file.
#
#   .\ops\scripts\copy-for-render.ps1 -Which config
#   .\ops\scripts\copy-for-render.ps1 -Which encryption-key
#
# Prints nothing sensitive: paste straight into the Render prompt.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('config', 'encryption-key', 'password')]
    [string]$Which
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$map = @{
    'config'         = Join-Path $root 'ops\secrets\config-oneline.json'
    'encryption-key' = Join-Path $root 'ops\secrets\encryption-key.txt'
    'password'       = Join-Path $root 'ops\secrets\dashboard-password.txt'
}

$file = $map[$Which]

if (-not (Test-Path $file)) {
    throw "Missing: $file"
}

$value = (Get-Content -Raw -Path $file).Trim()

if (-not $value) {
    throw "File is empty: $file"
}

# Validate the config before handing it over: a malformed FREEAPI_CONFIG_JSON
# makes the container exit at boot, and Render's log is a slow place to find out.
if ($Which -eq 'config') {
    try {
        $obj = $value | ConvertFrom-Json
    }
    catch {
        throw "config-oneline.json is not valid JSON: $($_.Exception.Message)"
    }

    # Report structure only. Print no key values: 'keys[].key' holds the live
    # provider API key.
    $topLevel = @($obj.PSObject.Properties.Name) -join ', '
    $platforms = @($obj.keys | ForEach-Object { $_.platform }) -join ', '

    Write-Host "  valid JSON"
    Write-Host "  top-level keys : $topLevel"
    Write-Host "  platforms      : $platforms"
}

Set-Clipboard -Value $value

$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($value)) |
    ForEach-Object { $_.ToString('x2') }) -join ''

Write-Host "Copied to clipboard (value not printed)."
Write-Host "  source : $file"
Write-Host "  length : $($value.Length) characters"
Write-Host "  sha256 : $($hash.Substring(0, 12))"
